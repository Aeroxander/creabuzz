import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * Deciding in the browser, against a REAL local chain.
 *
 * Opt-in: `scripts/web-decisions-e2e.sh` builds the world (a project launched into its own DAO through the kit, with one
 * decision opened: a work budget) and runs this spec. The page reads the decision from the chain; it takes it through
 * support, the wait and the run as the founder's wallet. What is stubbed: the relay (it only serves the launch record) and
 * the wallet (`window.ethereum` forwarding to Anvil's unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const FACTORY = process.env.E2E_FACTORY ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

test.skip(
  !ANVIL_URL || !DAO || !FACTORY,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_FACTORY (scripts/web-decisions-e2e.sh does)",
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

/** Let time pass on the chain, the way waiting a day would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

const record = {
  id: "record-decisions",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-decisions"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A DAO that decides in the open.",
    stage: "graduated",
    currency: CURRENCY || undefined,
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

/** The relay that serves the launch record, the founder's wallet, and the browser's settings: everything but the page. */
async function serve(page: Page) {
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
      if (filter.kinds?.includes(37001))
        ws.send(JSON.stringify(["EVENT", subId, record]));
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
}

async function openDecisions(page: Page) {
  await serve(page);
  await page.goto(`/launchpad/nebula-decisions?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Decisions" }).click();
  await expect(page.getByTestId("decisions-tab")).toBeVisible({
    timeout: 20_000,
  });
}

const mandateCreated = async () =>
  (
    (await rpc("eth_getLogs", [
      { address: FACTORY, fromBlock: "0x0", toBlock: "latest" },
    ])) as unknown[]
  ).length;

// Runs first: the decision it finds must still be open, before the next test takes it through to the end.
test("Home lists the decision waiting on the founder, and its button opens it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await serve(page);
  await page.goto("/");
  const waiting = page.getByTestId("home-waiting");
  await expect(waiting).toBeVisible({ timeout: 60_000 });
  const item = waiting.getByTestId("home-waiting-item").first();
  await expect(item).toContainText("Nebula DAO");
  await expect(item).toContainText("Open for your vote");
  await item.getByTestId("home-waiting-open").click();
  await expect(page).toHaveURL(/tab=decisions/);
  await expect(page.getByTestId("decisions-tab")).toBeVisible({
    timeout: 20_000,
  });
});

test("a decision opened elsewhere is read from the chain, backed, waited out and run, all in the page", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const before = await mandateCreated();

  await openDecisions(page);
  const card = page.getByTestId("decision-card");
  await expect(card).toHaveCount(1);
  // What it would do, in words a voter can read, from the chain.
  await expect(page.getByTestId("decision-title")).toHaveText(
    "Set aside a work budget",
  );
  await expect(card).toContainText(
    "Shares for work: 100 in all, at most 40 per project",
  );
  await expect(card).toContainText("2 reviewers, 2 must agree on each claim");
  await expect(page.getByTestId("decision-status")).toHaveText(
    "Collecting support",
  );
  // Nothing can run in the review period, whatever the vote.
  await expect(page.getByTestId("decision-next")).toContainText(
    "Nothing can run before",
  );
  await expect(page.getByTestId("decision-run")).toHaveCount(0);
  await expect(page.getByTestId("decision-start-wait")).toHaveCount(0);

  // The founder backs it with all their Shares, from their own wallet.
  await expect(page.getByTestId("decision-vote-summary")).toContainText(
    "200,000,000",
    {
      timeout: 20_000,
    },
  );
  await page.getByTestId("decision-vote-for").click();
  await expect(page.getByTestId("decision-vote-summary")).toContainText(
    "you are backing this with 200,000,000",
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByTestId("decision-support")).toContainText(
    "Backing 200,000,000",
  );
  await expect(page.getByTestId("decision-failure")).toHaveCount(0);

  // The review period and the hold pass; the decision is approved, and the page says what to do.
  await pass(175_000);
  await page.reload();
  await page.getByRole("tab", { name: "Decisions" }).click();
  await expect(page.getByTestId("decision-status")).toHaveText("Approved", {
    timeout: 30_000,
  });
  await page.getByTestId("decision-start-wait").click();
  await expect(page.getByTestId("decision-status")).toHaveText(
    "Waiting to run",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("decision-run")).toHaveCount(0);

  // Once the wait is over anyone can run it.
  await pass(90_000);
  await page.reload();
  await page.getByRole("tab", { name: "Decisions" }).click();
  await expect(page.getByTestId("decision-status")).toHaveText("Ready to run", {
    timeout: 30_000,
  });
  await page.getByTestId("decision-run").click();
  await expect(page.getByTestId("decision-status")).toHaveText("Done", {
    timeout: 30_000,
  });

  // The chain agrees: the work budget exists.
  expect(await mandateCreated()).toBe(before + 1);
});
