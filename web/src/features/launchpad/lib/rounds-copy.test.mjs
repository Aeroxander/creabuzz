import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bidPlan,
  clearingLine,
  roundStatusLine,
  roundsStateLine,
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
