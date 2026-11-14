import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { PREVIEW_ORIGIN } from "./mock-relay";

/**
 * A DAO's public track record, for a DAO that moved MONEY, against a REAL local chain.
 *
 * Opt-in: `scripts/web-record-e2e.sh` builds the world (a project launched into its own DAO, a work budget holding 1,000,
 * one claim for 200 approved by two reviewers and paid, one for 100 turned down by both) and runs this spec. The page is
 * opened with NO wallet: the record is the same for everyone. What is stubbed: the relay (it only serves the launch record).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? "";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

test.skip(
  !ANVIL_URL || !DAO || !CURRENCY,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_CURRENCY (scripts/web-record-e2e.sh does)",
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

const record = {
  id: "record-money",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-record"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A DAO that pays for work.",
    stage: "graduated",
    currency: CURRENCY,
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

async function openRecord(page: Page) {
  await page.routeWebSocket(PREVIEW_ORIGIN, (ws) => {
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
  await page.addInitScript((rpcUrl) => {
    window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
  }, ANVIL_URL);
  await page.goto(`/launchpad/nebula-record?author=${FOUNDER}&tab=record`);
  await expect(page.getByTestId("record-tab")).toBeVisible({ timeout: 20_000 });
}

test("someone with no wallet can read what was set aside, paid and turned down", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openRecord(page);

  // The money, in the numbers the contracts hold: 1,000 set aside, 200 paid, nothing still waiting.
  await expect(page.getByTestId("record-figure-approved")).toContainText(
    "1,000",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("record-figure-paid")).toContainText("200");
  await expect(page.getByTestId("record-figure-waiting")).toContainText("0");
  await expect(page.getByTestId("record-figure-work")).toContainText(
    "1 paid · 0 in review · 1 not paid",
  );

  // The treasury figure is the chain's own balance, not a sum of what the page was told.
  const balance = BigInt(
    String(
      await rpc("eth_call", [
        {
          to: CURRENCY,
          data: `0x70a08231${DAO.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );
  const whole = (balance / 1_000_000n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",?");
  await expect(page.getByTestId("record-figure-treasury")).toContainText(
    new RegExp(whole),
  );

  // Who holds the Shares, added up from the Shares' own history and checked against their total supply: nothing is
  // missing, the team's holding says how long it has lasted, and the part still tied to milestones is said.
  const holders = page.getByTestId("record-holders");
  await expect(holders.getByTestId("record-holder").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(holders.getByTestId("record-holders-incomplete")).toHaveCount(0);
  await expect(holders.getByTestId("record-holder-age").first()).toContainText(
    "held for",
  );
  await expect(
    holders.getByTestId("record-holder-locked").first(),
  ).toContainText("held back until milestones are reached");
  // Every figure is a share of the whole, so together they never pass 100%.
  const percents = await holders
    .getByTestId("record-holder-share")
    .allTextContents();
  const total = percents
    .map((text) => Number.parseFloat(text))
    .reduce((sum, value) => sum + value, 0);
  expect(percents.length).toBeGreaterThan(0);
  expect(total).toBeGreaterThan(99.5);
  expect(total).toBeLessThanOrEqual(100.5);

  // What happened: the payment, who approved it, and the claim that was turned down with who objected.
  const entries = page.getByTestId("record-entry");
  await expect(entries.filter({ hasText: "was paid 200" })).toHaveCount(1);
  const approval = entries.filter({
    hasText: "The reviewers approved the work",
  });
  await expect(approval).toContainText("Approved by");
  const turnedDown = entries.filter({ hasText: "submitted work for 100" });
  await expect(turnedDown).toContainText("Turned down by the reviewers");
  await expect(turnedDown).toContainText("Objected to by");
  await expect(
    entries.filter({ hasText: "submitted work for 200" }),
  ).toContainText("Approved by the reviewers and paid");

  // Filtering to payments leaves only the payment.
  await page.getByRole("button", { name: "Payments" }).click();
  await expect(entries).toHaveCount(1);
  // Addresses are shown lower-case; the world's are checksummed.
  await expect(entries.first()).toContainText(
    new RegExp(CONTRIBUTOR.slice(0, 6), "i"),
  );
});
