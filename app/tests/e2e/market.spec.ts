import { expect, type Page, test } from "@playwright/test";
import {
  bidCalls,
  finishCall,
  handBackCalls,
  MARKET_READS,
} from "../../src/features/market/market-calls";
import { poolSlots } from "../../src/features/market/use-market";
import { BACKER_EVM, CONTRACTS } from "../helpers/numbers-fixture";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { addressWord, word } from "./helpers/chain-wallet";
import { sentCalls } from "./helpers/money-world";
import { MATE_KEY, openTeam, seedTeam } from "./helpers/team-world";
import { createMockRelay } from "./mock-relay";
import { LEGACY_BUILD, LEGACY_WHY } from "./helpers/legacy-build";

test.skip(!LEGACY_BUILD, LEGACY_WHY);

/**
 * The auction and the pool in the app (plan v2, milestone 7), press-counted at 390x844: Bid in 2 presses and 1 field,
 * Hand back in 2 and 1, the finish steps in 1. The wallet answers the chain's reads and records what it is asked to
 * send. Buy and Sell need the server's trading switch and a trade router named by the build; their 2 presses and 1 field
 * are held in `market-screens.test.tsx` (this smoke build names no router, so they are not offered here).
 */

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const HOOK = "0x9b3c000000000000000000000000000000002000";
const MANAGER = "0x7e57000000000000000000000000000000000e57";
const FLOOR = 31_691_265_005_800n;
const SHARE = 10n ** 18n;

function sale(o: { settled?: boolean; pool?: boolean; bid?: string }) {
  return (content: Record<string, unknown>) => ({
    sale: {
      auction: AUCTION,
      minimum: "100000000000",
      startBlock: "1000",
      endBlock: "8200",
      floorPriceQ96: FLOOR.toString(),
      tickSpacingQ96: (FLOOR / 100n).toString(),
      openedAt: (content.asOf as { time: number }).time - 3600,
      ...(o.settled
        ? {
            settled: {
              raised: "120000000000",
              afterFee: "116400000000",
              toTreasury: "90000000000",
            },
          }
        : {}),
      ...(o.pool
        ? {
            pool: {
              poolId: `0x${"22".repeat(32)}`,
              sqrtPriceX96: "1584563250285286751870879006720",
              poolDollars: "26400000000",
              poolShares: "66000000000000000000000000",
            },
          }
        : {}),
    },
    bids: [
      {
        auction: AUCTION,
        count: 5,
        amount: o.bid ?? "120000000000",
        clearingPriceQ96: (FLOOR * 2n).toString(),
      },
    ],
  });
}

async function greens(page: Page) {
  return page.locator(".btn-primary:visible").count();
}

test("a backer bids in 2 presses and 1 field, at the most the auction allows", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedTeam(relay, "team", sale({}));
  await openTeam(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    block: 2_000,
    reads: { "quote()": `0x${addressWord(CONTRACTS.quote)}` },
  });
  const box = page.getByTestId("bid-box");
  await expect(box).toBeVisible({ timeout: 20_000 });
  await expect(box).toContainText("the most anyone pays is 0.0016");
  const path = new PressCounter();
  await path.read(page, "The bid box", box);
  await path.type(page.getByTestId("bid-amount"), "250", "Dollars to bid");
  await path.press(page.getByTestId("bid-review"), "Bid");
  await expect(page.getByTestId("bid-sheet")).toBeVisible();
  await page.waitForTimeout(400);
  await path.read(page, "The bid sheet", page.getByTestId("bid-sheet"));
  await path.press(page.getByTestId("bid-sheet-confirm"), "Place the bid");
  await expect(page.getByText("Your bid is in.")).toBeVisible();
  const sent = await sentCalls(page);
  const expected = bidCalls({
    auction: AUCTION,
    quote: CONTRACTS.quote,
    owner: BACKER_EVM,
    amount: 250_000_000n,
    floorQ96: FLOOR,
    permit2Allowance: 0n,
    deadline: 0n,
  });
  expect(sent.map((c) => c.to)).toEqual(expected.map((c) => c.to));
  expect(sent[0].data).toBe(expected[0].data);
  expect(sent[2].data).toBe(expected[2].data);
  console.log(path.summary("Bid"));
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.bidBuySellHandBack.presses,
  );
  expect(path.fields).toBe(PLAN_V2_BUDGETS.bidBuySellHandBack.fields);
  await expectNoSidewaysScroll(page, "Bid");
});

test("anyone finishes an ended sale in 1 press", async ({ page }) => {
  const relay = createMockRelay();
  seedTeam(relay, "team", sale({}));
  // The pool step has not run: the pool strategy still keeps the pool's id for this auction.
  await openTeam(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    block: 8_300,
    reads: {
      "poolKey()": `0x${addressWord(CONTRACTS.quote)}${addressWord(CONTRACTS.shares)}${word(10_000)}${word(200)}${addressWord(HOOK)}`,
      "strategy()": `0x${addressWord(MANAGER)}`,
      "registeredPoolIds(bytes32)": `0x${addressWord(AUCTION)}`,
    },
  });
  const press = page.getByTestId("finish-press");
  await expect(press).toBeVisible({ timeout: 20_000 });
  const path = new PressCounter();
  await path.press(press, "Finish the sale");
  await expect(page.getByText("Done. The numbers here catch up")).toBeVisible();
  expect((await sentCalls(page)).map((c) => c.data)).toEqual(
    (["openPool", "settle", "sweep"] as const).map(
      (s) => finishCall(CONTRACTS.finisher, s).data,
    ),
  );
  expect(path.presses).toBe(1);
  expect(await greens(page)).toBeLessThanOrEqual(1);
});

test("a holder sees the price beside its depth and hands Shares back in 2 presses and 1 field", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedTeam(relay, "team", sale({ settled: true, pool: true }));
  const slots = poolSlots({
    currency0: CONTRACTS.quote,
    currency1: CONTRACTS.shares,
    fee: 10_000,
    tickSpacing: 200,
    hooks: HOOK,
  });
  const sqrt = BigInt(Math.round(Math.sqrt(2_500 * 1e12) * 2 ** 96));
  const liquidity = BigInt(Math.round(Math.sqrt(26_400e6 * 66e24)));
  await openTeam(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    block: 9_000,
    reads: {
      "poolKey()": `0x${addressWord(CONTRACTS.quote)}${addressWord(CONTRACTS.shares)}${word(10_000)}${word(200)}${addressWord(HOOK)}`,
      "poolManager()": `0x${addressWord(MANAGER)}`,
      "melting()": `0x${word(60_000_000_000n)}`,
      "meltRemaining()": `0x${word(365n * 86_400n)}`,
      "countingSupply()": `0x${word(250_000_000n * SHARE)}`,
      "totalSupply()": `0x${word(1_000_000_000n * SHARE)}`,
      "saleClosed()": `0x${word(1)}`,
    },
    exact: {
      [MARKET_READS.extsload(slots.slot0)]: `0x${word(sqrt)}`,
      [MARKET_READS.extsload(slots.liquidity)]: `0x${word(liquidity)}`,
    },
  });
  await expect(page.getByTestId("pool-price")).toHaveText(
    "0.0004 dollars a Share",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("pool-depth")).toContainText(
    "A 100-dollar buy moves it about",
  );
  await expect(page.getByTestId("pool-floor")).toContainText("0.00024");
  const path = new PressCounter();
  await path.press(page.getByTestId("hand-back"), "Hand back");
  await path.type(page.getByTestId("hand-back-amount"), "1000", "Shares");
  await expect(page.getByTestId("hand-back-estimate")).toContainText(
    "About 0.22 dollars come back",
  );
  await path.press(page.getByTestId("hand-back-sheet-confirm"), "Hand back");
  await expect(page.getByText("Handed back.")).toBeVisible();
  expect((await sentCalls(page)).map((c) => c.data)).toEqual(
    handBackCalls(CONTRACTS.shares, CONTRACTS.treasury, 1_000n * SHARE).map(
      (c) => c.data,
    ),
  );
  console.log(path.summary("Hand back"));
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.bidBuySellHandBack.presses,
  );
  expect(path.fields).toBe(PLAN_V2_BUDGETS.bidBuySellHandBack.fields);
  // The floor as a melting line on the Money tab.
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("floor-line")).toBeVisible();
});
