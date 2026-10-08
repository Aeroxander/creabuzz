import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * Unlocking the team's Shares in the browser, against a REAL local chain.
 *
 * Opt-in: `scripts/web-milestone-e2e.sh` builds the world (a project launched into its own DAO through the kit with the
 * founder's Shares locked behind two milestones, and a Paid claim for the first) and runs this spec. What is stubbed:
 * the relay (it only serves the launch record) and the wallet (`window.ethereum` forwarding to Anvil's unlocked
 * accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const LOCK = process.env.E2E_LOCK ?? "";
const SHARES = process.env.E2E_SHARES ?? "";
const STRANGER = process.env.E2E_STRANGER ?? "";
// Anvil's first dev account: the founder, who holds the team's Shares.
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const WAD = 10n ** 18n;
const TEAM = 200_000_000n * WAD;
const SECOND_TRANCHE = 120_000_000n * WAD;

test.skip(
  !ANVIL_URL || !DAO || !LOCK,
  "set E2E_ANVIL_URL, E2E_DAO, E2E_LOCK and E2E_SHARES (scripts/web-milestone-e2e.sh does)",
);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

const word = (value: string) => value.slice(2).toLowerCase().padStart(64, "0");
const lockedOf = async (holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        { to: LOCK, data: `0xa5f1e282${word(holder)}` },
        "latest",
      ]),
    ),
  );

const record = {
  id: "record-milestone",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-milestone"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A team that earns its Shares.",
    stage: "graduated",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
    unlocks: {
      mode: "milestones",
      allocationPct: 10,
      milestones: [
        {
          claim: "m1",
          label: "alpha shipped",
          percent: 40,
          verifier: "founder",
        },
        {
          claim: "m2",
          label: "mainnet live",
          percent: 60,
          verifier: "founder",
        },
      ],
      months: null,
    },
  }),
  sig: "sig",
};

/** A tiny relay: serves the launch record and nothing else. */
async function serveRecord(page: Page) {
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        ws.send(
          JSON.stringify(["OK", (parsed[1] as { id: string }).id, true, ""]),
        );
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if (filter.kinds?.includes(37001)) {
        ws.send(JSON.stringify(["EVENT", subId, record]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

/** Open the Work tab as one person's wallet. */
async function openWork(page: Page, account: string) {
  await serveRecord(page);
  await installAnvilWallet(page, account, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(`/launchpad/nebula-milestone?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Work" }).click();
  await expect(page.getByTestId("work-tab")).toBeVisible({ timeout: 20_000 });
}

test("the founder sees what is locked, unlocks the first milestone with one click, and a stranger sees nothing of it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  expect(await lockedOf(FOUNDER_WALLET)).toBe(TEAM);

  await openWork(page, FOUNDER_WALLET);
  const card = page.getByTestId("locked-shares");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("locked-shares-total")).toContainText(
    "200,000,000 Shares are still locked",
  );

  // The first milestone has a Paid claim waiting; the second has nothing yet.
  const first = page.getByTestId("locked-shares-milestone-0");
  await expect(first).toContainText("80,000,000 Shares");
  await expect(first).toContainText("alpha shipped");
  const second = page.getByTestId("locked-shares-milestone-1");
  await expect(second).toContainText("120,000,000 Shares");
  await expect(second).toContainText("mainnet live");
  await expect(page.getByTestId("locked-shares-unlock-1")).toHaveCount(0);
  await expect(second).toContainText("File a claim");

  await page.getByTestId("locked-shares-unlock-0").click();
  await expect(page.getByTestId("locked-shares-total")).toContainText(
    "120,000,000 Shares are still locked",
    { timeout: 60_000 },
  );
  await expect(first).toContainText("Unlocked");
  await expect(page.getByTestId("locked-shares-unlock-0")).toHaveCount(0);
  await expect(page.getByTestId("work-failure")).toHaveCount(0);

  // The chain agrees: only the second milestone's part is still held back, and the Shares refuse to move it.
  expect(await lockedOf(FOUNDER_WALLET)).toBe(SECOND_TRANCHE);
  const balance = BigInt(
    String(
      await rpc("eth_call", [
        { to: SHARES, data: `0x70a08231${word(FOUNDER_WALLET)}` },
        "latest",
      ]),
    ),
  );
  expect(balance).toBe(TEAM);

  // Someone with no team Shares has nothing locked, so the card is not shown to them.
  const stranger = await browser.newPage();
  await openWork(stranger, STRANGER);
  await expect(stranger.getByTestId("locked-shares")).toHaveCount(0);
  await stranger.close();
});
