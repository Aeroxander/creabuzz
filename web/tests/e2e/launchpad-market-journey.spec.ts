import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * A project's market run entirely from the browser, against a REAL local chain with the Limit Break AMM on it.
 *
 * Opt-in: `scripts/web-market-journey-e2e.sh` builds the world (a project launched into its own DAO) and runs this spec.
 * The founder puts a market to a vote and runs it; a buyer buys and sells on the launch page; a founder whose Shares are
 * locked cannot sell them; and the founder collects the trading fees into the treasury by another vote. What is stubbed:
 * the relay (it only serves the launch record) and the wallets (`window.ethereum` forwarding to Anvil's accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const SHARES = process.env.E2E_SHARES ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const AMM = process.env.E2E_AMM ?? "";
const BUYER = process.env.E2E_BUYER ?? "";
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const WAD = 10n ** 18n;

test.skip(
  !ANVIL_URL || !DAO || !SHARES || !AMM,
  "set E2E_ANVIL_URL, E2E_DAO, E2E_SHARES and E2E_AMM (scripts/web-market-journey-e2e.sh does)",
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

async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

const balanceOf = async (token: string, holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        {
          to: token,
          data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );

const record = {
  id: "record-market-journey",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-market-journey"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["token", SHARES],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A market for the Shares.",
    stage: "graduated",
    currency: CURRENCY,
    floorPrice: "792281625140000",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

async function openAs(page: Page, account: string, tab?: "Decisions") {
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
  await installAnvilWallet(page, account, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(`/launchpad/nebula-market-journey?author=${FOUNDER}`);
  if (tab) await page.getByRole("tab", { name: tab }).click();
}

async function refreshDecisions(page: Page) {
  await page.reload();
  await page.getByRole("tab", { name: "Decisions" }).click();
}

async function carryOut(
  page: Page,
  secondsToApprove: number,
  secondsToWait: number,
) {
  const card = page.getByTestId("decision-card").first();
  await expect(card.getByTestId("decision-status")).toHaveText(
    "Collecting support",
    { timeout: 30_000 },
  );
  await card.getByTestId("decision-vote-for").click();
  await expect(card.getByTestId("decision-support")).toContainText(
    "Backing 200,000,000",
    { timeout: 30_000 },
  );
  await pass(secondsToApprove);
  await refreshDecisions(page);
  const next = page.getByTestId("decision-card").first();
  await expect(next.getByTestId("decision-status")).toHaveText("Approved", {
    timeout: 30_000,
  });
  await next.getByTestId("decision-start-wait").click();
  await expect(next.getByTestId("decision-status")).toHaveText(
    "Waiting to run",
    { timeout: 30_000 },
  );
  await pass(secondsToWait);
  await refreshDecisions(page);
  const ready = page.getByTestId("decision-card").first();
  await expect(ready.getByTestId("decision-status")).toHaveText(
    "Ready to run",
    { timeout: 30_000 },
  );
  await ready.getByTestId("decision-run").click();
  await expect(ready.getByTestId("decision-status")).toHaveText("Done", {
    timeout: 60_000,
  });
}

test("a market is voted in, traded on the launch page, and its fees collected, all from pages", async ({
  context,
}) => {
  test.setTimeout(420_000);

  // ── 1. the founder puts a market to a vote, in a form ───────────────────────────────────
  const founder = await context.newPage();
  await openAs(founder, FOUNDER_WALLET, "Decisions");
  // Before the vote there is nothing to trade, so nobody is offered a trade.
  await expect(founder.getByTestId("decisions-tab")).toBeVisible({
    timeout: 20_000,
  });
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-market").click();
  await founder.getByTestId("market-shares").fill("100000000");
  await founder.getByTestId("market-price").fill("0.01");
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Put 100,000,000 Shares on the market",
    {
      timeout: 30_000,
    },
  );
  await expect(founder.getByTestId("decision-draft")).toContainText(
    "A 1% fee on every trade goes to the DAO",
  );
  // More Shares than the DAO holds of its own is refused before anything is sent.
  await founder.getByTestId("market-shares").fill("900000000000");
  await expect(founder.getByTestId("decision-draft-problem")).toContainText(
    "The DAO holds only",
  );
  await founder.getByTestId("market-shares").fill("100000000");
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000);
  expect(await balanceOf(SHARES, AMM)).toBeGreaterThan(99_999_000n * WAD);

  // ── 2. a buyer trades on the launch page ────────────────────────────────────────────────
  const buyer = await context.newPage();
  await openAs(buyer, BUYER);
  const trade = buyer.getByTestId("trade-card");
  await expect(trade).toBeVisible({ timeout: 30_000 });
  await expect(buyer.getByTestId("trade-price")).toContainText(
    /Price 0\.0\d+ per NEB/,
  );
  await buyer.getByTestId("trade-amount").fill("1000");
  await expect(buyer.getByTestId("trade-estimate")).toContainText(
    /You get about [\d,]+/,
    { timeout: 15_000 },
  );
  const before = await balanceOf(SHARES, BUYER);
  await buyer.getByTestId("trade-submit").click();
  await expect(buyer.getByTestId("trade-done")).toHaveText("Bought.", {
    timeout: 90_000,
  });
  const bought = (await balanceOf(SHARES, BUYER)) - before;
  expect(bought).toBeGreaterThan(90_000n * WAD);
  expect(bought).toBeLessThan(100_000n * WAD);

  // ── a founder whose Shares are locked cannot sell them, and the page says why ────────────
  await founder.goto(`/launchpad/nebula-market-journey?author=${FOUNDER}`);
  await founder.getByTestId("trade-sell").click();
  await expect(founder.getByTestId("trade-balance")).toContainText(
    "You can sell up to 0",
    { timeout: 20_000 },
  );
  await expect(founder.getByTestId("trade-balance")).toContainText(
    "200,000,000",
  );
  await expect(founder.getByTestId("trade-balance")).toContainText(
    "locked until milestones are reached",
  );
  await founder.getByTestId("trade-amount").fill("1000");
  await founder.getByTestId("trade-submit").click();
  await expect(founder.getByTestId("trade-problem")).toContainText(
    "locked until milestones are reached",
  );
  expect(await balanceOf(SHARES, FOUNDER_WALLET)).toBe(200_000_000n * WAD);

  // ── the buyer sells some back ────────────────────────────────────────────────────────
  await buyer.getByTestId("trade-sell").click();
  await buyer.getByTestId("trade-amount").fill("10000");
  await buyer.getByTestId("trade-submit").click();
  await expect(buyer.getByTestId("trade-done")).toHaveText("Sold.", {
    timeout: 90_000,
  });
  expect(await balanceOf(SHARES, BUYER)).toBeLessThan(before + bought);

  // ── 3. the fees the trades paid are collected into the treasury by another vote ───────────
  await refreshDecisions(founder);
  const treasuryBefore = await balanceOf(CURRENCY, DAO);
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-fees").click();
  await expect(founder.getByTestId("fees-owed")).toContainText(
    /Collected so far: [1-9]/,
    { timeout: 20_000 },
  );
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Collect the trading fees",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000);
  const collected = (await balanceOf(CURRENCY, DAO)) - treasuryBefore;
  expect(collected).toBeGreaterThan(0n);

  // ── 4. the treasury pays someone out of what it collected, by vote ─────────────────────────
  const payee = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // an Anvil account that has none yet
  const payeeBefore = await balanceOf(CURRENCY, payee);
  await refreshDecisions(founder);
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-pay").click();
  await expect(founder.getByTestId("pay-balance")).toContainText(
    "The treasury holds",
    { timeout: 20_000 },
  );
  await founder.getByTestId("pay-recipient").fill(payee);
  await founder.getByTestId("pay-amount").fill("100");
  // More than the treasury holds is refused before anything is sent.
  await expect(founder.getByTestId("decision-draft-problem")).toContainText(
    "The treasury holds only",
  );
  await founder.getByTestId("pay-amount").fill("0.5");
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Pay 0.5 USDC from the treasury",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000);
  expect((await balanceOf(CURRENCY, payee)) - payeeBefore).toBe(500_000n);
});
