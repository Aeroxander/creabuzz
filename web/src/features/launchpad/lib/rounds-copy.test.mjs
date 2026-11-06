import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bidPlan,
  clearingLine,
  floorAtOpeningText,
  historyRow,
  lastTradeLine,
  leavingLine,
  leavingPays,
  offerPlanLine,
  roundStatusLine,
  roundsStateLine,
  roundUnit,
  sellPlan,
} from "./rounds-copy.ts";

const USD = 1_000_000n;
const E18 = 10n ** 18n;
const grid = { floor: USD, step: USD / 100n };

test("whether rounds are on reads as one sentence", () => {
  assert.match(roundsStateLine("off", null), /no weekly rounds yet/);
  assert.match(roundsStateLine("ready", null), /Anyone can switch them on/);
  assert.match(roundsStateLine("on", null), /never below what leaving pays/);
  assert.equal(roundsStateLine("unlocked", null), null);
});

test("a round's status and what it trades", () => {
  assert.match(
    roundStatusLine({ phase: "bidding", closesAt: 0 }, 0),
    /^Taking offers and bids until /,
  );
  assert.match(
    roundStatusLine({ phase: "void", closesAt: 0 }, 0),
    /takes back/,
  );
  const round = {
    phase: "bidding",
    floor: USD,
    step: USD / 100n,
    clearing: { step: 30, volume: 50n * E18, sellersShare: false },
  };
  assert.equal(
    clearingLine(round),
    "If bidding ended now: 50 Shares at 1.3 USDC each.",
  );
  assert.equal(
    clearingLine({ ...round, phase: "settled" }),
    "50 Shares at 1.3 USDC each changed hands.",
  );
  assert.equal(
    clearingLine({ ...round, clearing: { ...round.clearing, volume: 0n } }),
    "Nothing would trade yet.",
  );
  // A funding round sells new shares for the project, of whichever kind its terms give buyers.
  assert.equal(
    clearingLine({ ...round, phase: "settled", funding: true }),
    "50 new shares at 1.3 USDC each were sold for the project.",
  );
});

test("a seller's lowest price is the step at or above it, and what they keep after the cut", () => {
  assert.deepEqual(sellPlan(grid, "50", "1.3", 200n * E18, false), {
    amount: 50n * E18,
    step: 30,
    keepsEach: (124n * USD) / 100n,
  });
  assert.deepEqual(sellPlan(grid, "50", "0.5", 200n * E18, false).step, 0);
  assert.match(
    sellPlan(grid, "201", "1", 200n * E18, false).problem,
    /up to 200/,
  );
  assert.match(
    sellPlan(grid, "1", "1.01", 200n * E18, true).problem,
    /2% above/,
  );
});

test("a buyer's highest price is the step at or below it, and what the bid holds", () => {
  assert.deepEqual(bidPlan(grid, "30", "1.305", 100n * USD), {
    amount: 30n * E18,
    step: 30,
    holds: 39n * USD,
  });
  assert.match(
    bidPlan(grid, "30", "0.9", 100n * USD).problem,
    /at least 1 USDC/,
  );
  assert.match(
    bidPlan(grid, "30", "1.3", 10n * USD).problem,
    /holds 39 USDC; you have 10 USDC/,
  );
});

// ---- price history and leaving (D147) ----------------------------------------------------------------

// Midday UTC, so the date is the same day in every time zone the tests run in.
const OCT_21 = Date.UTC(2026, 9, 21, 12) / 1000;

test("the last trade keeps its round and date; before any trade it says so", () => {
  assert.equal(
    lastTradeLine({
      lastTrade: {
        id: 6n,
        closesAt: OCT_21,
        outcome: "traded",
        price: 3_100_000n,
        volume: 40n * E18,
      },
      complete: true,
    }),
    "Last trade: 40 Shares at 3.1 USDC each, round 6 (Oct 21).",
  );
  assert.equal(
    lastTradeLine({ lastTrade: null, complete: true }),
    "No trades yet.",
  );
  assert.equal(
    lastTradeLine({ lastTrade: null, complete: false }),
    "No trades in recent rounds.",
    "never 'yet' when older rounds were not read",
  );
});

test("a round that traded nothing, or was never settled, never carries a price", () => {
  assert.deepEqual(
    historyRow({
      id: 2n,
      closesAt: OCT_21,
      outcome: "traded",
      price: 1_300_000n,
      volume: 50n * E18,
    }),
    { date: "Oct 21", price: "1.3 USDC", amount: "50 Shares", note: null },
  );
  assert.deepEqual(
    historyRow({ id: 3n, closesAt: OCT_21, outcome: "nothing" }),
    {
      date: "Oct 21",
      price: null,
      amount: null,
      note: "Nothing traded",
    },
  );
  assert.deepEqual(historyRow({ id: 4n, closesAt: OCT_21, outcome: "void" }), {
    date: "Oct 21",
    price: null,
    amount: null,
    note: "Not settled, everything returned",
  });
});

test("what leaving pays now: the floor less the exit fee, saying when one applies", () => {
  assert.equal(leavingPays(2n * USD, 200n), 1_960_000n);
  assert.equal(
    leavingLine(2n * USD, 200n),
    "Leaving now pays about 1.96 USDC a Share, after the 2% exit fee.",
  );
  assert.equal(
    leavingLine(2n * USD, 250n),
    "Leaving now pays about 1.95 USDC a Share, after the 2.5% exit fee.",
  );
  // No funding terms, or terms still under notice: the exit reads a zero fee, and the line names none.
  assert.equal(
    leavingLine(2n * USD, 0n),
    "Leaving now pays about 2 USDC a Share.",
  );
  assert.equal(
    floorAtOpeningText(USD, "Share"),
    "Floor at opening: 1 USDC a Share",
  );
});

test("the offer form shows what a seller keeps beside what leaving pays", () => {
  assert.equal(
    offerPlanLine(1_240_000n, 980_000n),
    "If the round settles there, you keep 1.24 USDC a Share after the project's cut. A higher price pays you more; below it, nothing sells. Leaving now pays about 0.98 USDC a Share.",
  );
  assert.doesNotMatch(offerPlanLine(1_240_000n, null), /Leaving/);
});

test("a funding round names what it sells: new Shares or new non-voting shares, never Shares by default", () => {
  const SHARES = "0xAAaa000000000000000000000000000000000001";
  const LOOT = "0xbbbb000000000000000000000000000000000002";
  assert.equal(roundUnit({ funding: false, shares: SHARES }, SHARES), "Shares");
  assert.equal(
    roundUnit({ funding: true, shares: LOOT }, SHARES),
    "non-voting shares",
  );
  assert.equal(
    roundUnit({ funding: true, shares: SHARES.toLowerCase() }, SHARES),
    "Shares",
  );
  assert.equal(roundUnit({ funding: true, shares: LOOT }, null), "shares");
  const round = {
    phase: "settled",
    funding: true,
    floor: USD,
    step: USD / 100n,
    clearing: { step: 30, volume: 50n * E18, sellersShare: false },
  };
  assert.equal(
    clearingLine(round, roundUnit({ funding: true, shares: LOOT }, SHARES)),
    "50 new non-voting shares at 1.3 USDC each were sold for the project.",
  );
  assert.equal(
    clearingLine(round, roundUnit({ funding: true, shares: SHARES }, SHARES)),
    "50 new Shares at 1.3 USDC each were sold for the project.",
  );
});

test("the old rounds' prices carry the one-person label wherever a trade price is printed", async () => {
  const rounds = await import("./rounds-copy.ts");
  const round = {
    phase: "settled",
    floor: USD,
    step: USD / 100n,
    funding: false,
    clearing: { step: 30, volume: 50n * E18, sellersShare: false },
  };
  assert.equal(rounds.clearingShowsPrice?.(round), true);
  assert.equal(
    rounds.clearingShowsPrice?.({ ...round, phase: "bidding" }),
    true,
    "'If bidding ended now' prints a price too",
  );
  assert.equal(
    rounds.clearingShowsPrice?.({
      ...round,
      clearing: { ...round.clearing, volume: 0n },
    }),
    false,
  );
  // A funding round sells new shares for the project: no holder sells there, so the sentence would not be true.
  assert.equal(rounds.clearingShowsPrice?.({ ...round, funding: true }), false);
  const trade = {
    id: 6n,
    closesAt: OCT_21,
    outcome: "traded",
    price: 3_100_000n,
    volume: 40n * E18,
  };
  const quiet = { id: 5n, closesAt: OCT_21, outcome: "nothing" };
  assert.equal(
    rounds.historyShowsPrice?.({
      lastTrade: trade,
      rounds: [quiet],
      complete: true,
    }),
    true,
  );
  assert.equal(
    rounds.historyShowsPrice?.({
      lastTrade: null,
      rounds: [trade],
      complete: true,
    }),
    true,
  );
  assert.equal(
    rounds.historyShowsPrice?.({
      lastTrade: null,
      rounds: [quiet],
      complete: true,
    }),
    false,
  );
});
