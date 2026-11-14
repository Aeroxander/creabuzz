import { exactDecimal } from "@creaton/core/launchpad/backing.ts";
import {
  encodeFunctionData,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { expect, type Page, test } from "@playwright/test";

import { installAnvilWallet, pointChainAt } from "../helpers/anvil-wallet";
import { createMockRelay } from "./mock-relay";
import {
  DAY,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
  coordOf,
} from "./helpers/project-world";

/**
 * Investing against the REAL contracts on a local chain, in a real browser. Opt-in: it needs the world
 * `scripts/web-backing-e2e.sh` builds (the pool factory, the pool kit, the test token, three projects, the auction factory
 * and Permit2, and a web build that names them with the switch on); skipped without it.
 *
 * The story, each step a button on the page and a transaction on the chain, each checked against the chain:
 *   1. a backer puts money in (one approval and one buy) and sells half again; a second backer buys too;
 *   2. past the first milestone date the founder posts a milestone by picking one of the project's own records;
 *   3. the second backer leaves at it: all their units sold and all their held money back;
 *   4. the window ends and a visitor settles the milestone: the money reaches the project's treasury;
 *   5. a backer bids in the opening round of another project (Permit2, the auction's approval, the bid), the round is mined
 *      to its end, a visitor settles it, and the backer exchanges the round tokens for units. (The exit and the claim from
 *      the auction are sent to it directly: "My bids" is covered by the sale specs.)
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const QUOTE = process.env.E2E_QUOTE ?? "";
const POOL = process.env.E2E_POOL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const ROUND_POOL = process.env.E2E_ROUND_POOL ?? "";
const ROUND_DAO = process.env.E2E_ROUND_DAO ?? "";
const FOUNDER_WALLET = process.env.E2E_FOUNDER ?? "";
const BACKER_A = process.env.E2E_BACKER_A ?? "";
const BACKER_B = process.env.E2E_BACKER_B ?? "";

test.skip(
  process.env.E2E_BACKING_CHAIN !== "1" || !ANVIL_URL || !POOL || !ROUND_POOL,
  "run scripts/web-backing-e2e.sh: it builds the chain and the web app this needs",
);
test.describe.configure({ mode: "serial" });

const FOUNDER_KEY = "c1".repeat(32);
const VISITOR_KEY = "c2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const COORD = coordOf(FOUNDER, "born");
/** `BidSubmitted(uint256,address,uint256,uint128)`: the auction's own record of a bid. */
const BID_SUBMITTED =
  "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540";

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as string;
}
const call = async (to: string, data: string) =>
  BigInt(await rpc("eth_call", [{ to, data }, "latest"]));
const word = (address: string) =>
  encodeFunctionData("balanceOf(address)", ["address"], [address]);
const noArgs = (signature: string) => selectorOf(signature);
const unitsOf = (who: string) => call(POOL, word(who));
const quoteOf = (who: string) => call(QUOTE, word(who));
const warp = async (seconds: number) => {
  await rpc("anvil_increaseTime", [`0x${seconds.toString(16)}`]);
  await rpc("anvil_mine", ["0x1"]);
};
async function send(from: string, to: string, data: string) {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data }]);
  for (let i = 0; i < 50; i += 1) {
    const receipt = (await rpc("eth_getTransactionReceipt", [
      hash,
    ])) as unknown as { status: string } | null;
    if (receipt) {
      expect(receipt.status, "the chain accepted the step").toBe("0x1");
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no receipt");
}

async function openAs(
  page: Page,
  id: string,
  who: { nostr: string; wallet: string },
  records: ReturnType<typeof event>[] = [],
) {
  const relay = createMockRelay();
  relay.seed(
    event(
      0,
      FOUNDER,
      { name: "Fran Founder", display_name: "Fran Founder" },
      [],
      now() - 90 * DAY,
    ),
  );
  for (const [slug, dao] of [
    ["born", DAO],
    ["round", ROUND_DAO],
  ]) {
    relay.seed(
      projectRecord(
        FOUNDER,
        slug,
        slug === "born" ? "Born with a pool" : "Round project",
        now() - 60 * DAY,
        {
          content: {
            pitch: "A project on a real local chain.",
            stage: "graduated",
            funding: {
              stance: "not-raising",
              seeking: ["contributors"],
              path: "contributors",
            },
            tokenPlan: {
              mode: "dao",
              name: "Fixture",
              symbol: "BACK",
              supply: "100000",
            },
          },
          tags: [
            ["chain", "31337"],
            ["treasury", dao],
            ["token", `0x${"5e".repeat(20)}`],
          ],
        },
      ),
    );
  }
  for (const r of records) relay.seed(r);
  await install(page, relay, who.nostr);
  await pointChainAt(page, ANVIL_URL);
  await installAnvilWallet(page, who.wallet, { rpcUrl: ANVIL_URL });
  await page.goto(`/launchpad/${id}?author=${FOUNDER}`);
  await expect(page.getByTestId("backing")).toBeVisible({ timeout: 60_000 });
  return page.getByTestId("backing");
}

const visitor = (wallet: string) => ({ nostr: VISITOR_KEY, wallet });

// The round goes first. Its bid is approved through Permit2 for a short time counted from the browser's clock, and the
// tests after it move the chain's clock weeks ahead; a chain that is ahead of the browser would see that approval as expired.

test("a backer bids in an opening round; once settled, the round tokens become units", async ({
  page,
}) => {
  // The longest step: a bid is three transactions, then fifty thousand blocks, then the settle, the exit and the claim.
  test.setTimeout(180_000);
  const block = await openAs(page, "round", visitor(BACKER_A));
  await expect(block.getByTestId("backing-chip")).toHaveText("Opening round", {
    timeout: 60_000,
  });
  // The round's auction, as the pool itself names it.
  const AUCTION = `0x${(await call(ROUND_POOL, noArgs("auction()"))).toString(16).padStart(40, "0")}`;
  await block.getByTestId("backing-bid").click();
  await block.getByTestId("backing-bid-amount").fill("3000");
  await block.getByTestId("backing-confirm-bid").click();
  // The bid is on the auction's own log (its raised total is only counted at the next checkpoint).
  const bids = async () =>
    (
      (await rpc("eth_getLogs", [
        {
          address: AUCTION,
          fromBlock: "0x0",
          toBlock: "latest",
          topics: [BID_SUBMITTED],
        },
      ])) as unknown as unknown[]
    ).length;
  await expect.poll(bids, { timeout: 90_000 }).toBe(1);

  // The round runs for a fixed number of blocks: mine them, and anyone may settle it.
  await rpc("anvil_mine", [`0x${(50_100).toString(16)}`]);
  await page.reload();
  const after = page.getByTestId("backing");
  await expect(after.getByTestId("backing-round-ended")).toBeVisible({
    timeout: 60_000,
  });
  await after.getByTestId("backing-settle-round").click();
  await expect
    .poll(() => call(ROUND_POOL, noArgs("roundState()")), { timeout: 60_000 })
    .toBe(2n);

  // The auction pays the bidder in round tokens once the bid is exited and claimed (sent to the auction directly here).
  const logs = (await rpc("eth_getLogs", [
    {
      address: AUCTION,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [BID_SUBMITTED],
    },
  ])) as unknown as { topics: string[] }[];
  expect(logs.length).toBe(1);
  const bidId = BigInt(logs[0].topics[1]);
  await send(
    BACKER_A,
    AUCTION,
    encodeFunctionData("exitBid(uint256)", ["uint256"], [bidId]),
  );
  await send(
    BACKER_A,
    AUCTION,
    encodeFunctionData("claimTokens(uint256)", ["uint256"], [bidId]),
  );

  await page.reload();
  const done = page.getByTestId("backing");
  await expect(done.getByTestId("backing-redeem")).toContainText(
    "round tokens",
    { timeout: 60_000 },
  );
  await done.getByTestId("backing-redeem-button").click();
  await expect
    .poll(() => call(ROUND_POOL, word(BACKER_A)), { timeout: 60_000 })
    .toBeGreaterThan(0n);
  await expect(done.getByTestId("backing-redeem")).toHaveCount(0, {
    timeout: 60_000,
  });
});

test("a backer puts money in and sells half again; a second backer buys too", async ({
  page,
  browser,
}) => {
  const block = await openAs(page, "born", visitor(BACKER_A));
  await expect(block.getByTestId("backing-chip")).toHaveText("Open", {
    timeout: 60_000,
  });
  const before = await unitsOf(BACKER_A);
  await block.getByTestId("backing-back").click();
  await block.getByTestId("backing-amount").fill("100");
  await expect(block.getByTestId("backing-plan")).toContainText(
    "You get about",
    { timeout: 30_000 },
  );
  await block.getByTestId("backing-confirm-back").click();
  await expect(block.getByTestId("backing-done")).toHaveText(
    "Done. Your backing is in.",
    { timeout: 60_000 },
  );
  const bought = (await unitsOf(BACKER_A)) - before;
  expect(bought, "the chain holds the units the page said").toBeGreaterThan(0n);
  await expect(block.getByTestId("backing-position")).toContainText("You hold");

  // Sell half of them.
  const half = bought / 2n;
  await block.getByTestId("backing-sell").click();
  await block.getByTestId("backing-units").fill(exactDecimal(half, 18));
  await expect(block.getByTestId("backing-sell-plan")).toContainText(
    "You get about",
    { timeout: 30_000 },
  );
  await block.getByTestId("backing-confirm-sell").click();
  await expect
    .poll(() => unitsOf(BACKER_A), { timeout: 60_000 })
    .toBe(before + bought - half);

  // A second backer.
  const second = await (await browser.newContext()).newPage();
  const b2 = await openAs(second, "born", visitor(BACKER_B));
  await b2.getByTestId("backing-back").click({ timeout: 60_000 });
  await b2.getByTestId("backing-amount").fill("100");
  await expect(b2.getByTestId("backing-plan")).toContainText("You get about", {
    timeout: 30_000,
  });
  await b2.getByTestId("backing-confirm-back").click();
  await expect(b2.getByTestId("backing-done")).toHaveText(
    "Done. Your backing is in.",
    { timeout: 60_000 },
  );
  expect(await unitsOf(BACKER_B)).toBeGreaterThan(0n);
  await second.context().close();
});

test("past the first milestone date the founder posts a milestone by picking one of the project's own records", async ({
  page,
}) => {
  await warp(29 * 86_400);
  const update = event(
    47003,
    FOUNDER,
    { title: "Docs are live", body: "" },
    [["a", COORD]],
    now() - 2 * DAY,
  );
  const block = await openAs(
    page,
    "born",
    { nostr: FOUNDER_KEY, wallet: FOUNDER_WALLET },
    [update],
  );
  expect(await call(POOL, noArgs("milestoneCount()"))).toBe(0n);
  await block.getByTestId("backing-post").click({ timeout: 60_000 });
  await block
    .getByTestId("backing-record")
    .selectOption({ label: "Update: Docs are live" });
  await block.getByTestId("backing-confirm-post").click();
  await expect
    .poll(() => call(POOL, noArgs("milestoneCount()")), { timeout: 60_000 })
    .toBe(1n);
  await expect(block.getByTestId("backing-milestone").first()).toContainText(
    "Points at this project's record: Docs are live",
    {
      timeout: 60_000,
    },
  );
});

test("the second backer leaves at the milestone: all their units sold and all their held money back", async ({
  page,
}) => {
  const block = await openAs(page, "born", visitor(BACKER_B));
  const refundedBefore = await call(POOL, noArgs("refunded()"));
  await expect(block.getByTestId("backing-milestone-note")).toContainText(
    "you can stay",
    { timeout: 60_000 },
  );
  await block.getByTestId("backing-leave").click();
  await expect(block.getByTestId("backing-leave-plan")).toContainText(
    "You get about",
    { timeout: 30_000 },
  );
  await block.getByTestId("backing-confirm-leave").click();
  await expect.poll(() => unitsOf(BACKER_B), { timeout: 60_000 }).toBe(0n);
  expect(await call(POOL, noArgs("refunded()"))).toBeGreaterThan(
    refundedBefore,
  );
});

test("the window ends and a visitor settles the milestone: the money reaches the project's treasury", async ({
  page,
}) => {
  await warp(8 * 86_400);
  const block = await openAs(page, "born", visitor(BACKER_A));
  const treasuryBefore = await quoteOf(DAO);
  await expect(block.getByTestId("backing-settle")).toHaveText(
    "Settle the milestone",
    { timeout: 60_000 },
  );
  await block.getByTestId("backing-settle").click();
  await expect(block.getByTestId("backing-done")).toHaveText(
    "The milestone was settled.",
    { timeout: 60_000 },
  );
  expect(await call(POOL, noArgs("released()"))).toBeGreaterThan(0n);
  expect(await quoteOf(DAO)).toBeGreaterThan(treasuryBefore);
  await expect(block.getByTestId("backing-released")).not.toHaveText(
    "0 tTEST",
    { timeout: 60_000 },
  );
});
