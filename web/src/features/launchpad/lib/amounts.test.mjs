import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAtomic,
  formatBlocks,
  formatQ96PerToken,
  formatUsd,
  percentOfGoal,
  remainingToGraduate,
  toAtomic,
} from "./amounts.ts";

/**
 * Raw atomic units were what the launchpad printed: `1000000000 / 1000000000` is
 * not a number a buyer can act on.
 */

test("whole amounts read as money, without a decimal tail", () => {
  assert.equal(
    formatAtomic("300000000000", 6, { symbol: "USDC" }),
    "300,000 USDC",
  );
  // Rounded at the displayed digit, not truncated: a threshold set from a
  // percentage of a floor value lands a hair under a round number.
  assert.equal(formatUsd("299999999998"), "$300,000");
  assert.equal(formatAtomic("1000000", 6), "1");
  assert.equal(formatAtomic(0n, 6), "0");
  assert.equal(formatAtomic("1234567", 6), "1.234567");
});

test("unknown is unknown, not zero", () => {
  assert.equal(formatAtomic(null), "—");
  assert.equal(formatAtomic(""), "—");
  assert.equal(formatAtomic("not a number"), "—");
  assert.equal(formatUsd(undefined), "—");
  assert.equal(toAtomic("12.5"), null);
});

test("a Q96 floor becomes a price per token", () => {
  // 1 USD per whole 18-decimal token.
  const oneDollar = ((10n ** 6n) << 96n) / 10n ** 18n;
  assert.equal(formatQ96PerToken(oneDollar), "$1");
  // A cent per token, as the standard preset prices a 10M valuation.
  const oneCent = ((10n ** 4n) << 96n) / 10n ** 18n;
  const shown = formatQ96PerToken(oneCent);
  assert.match(shown, /^\$0\.0*1$/, `unexpected rendering: ${shown}`);
  assert.equal(formatQ96PerToken("0"), "—");
  assert.equal(formatQ96PerToken(null), "—");
});

test("blocks read as durations", () => {
  assert.equal(formatBlocks(43_200), "1 day");
  assert.equal(formatBlocks(216_000), "5 days");
  assert.equal(formatBlocks(21_600), "12 hours");
  assert.equal(formatBlocks(1_800), "1 hour");
  assert.equal(formatBlocks(0), "—");
  assert.equal(formatBlocks(null), "—");
});

test("progress and the distance to graduation", () => {
  assert.equal(percentOfGoal("150000000000", "300000000000"), 50);
  assert.equal(percentOfGoal("0", "0"), null);
  assert.equal(percentOfGoal(null, "300000000000"), null);
  assert.equal(percentOfGoal("100000000000", "300000000000"), 33.33);
  assert.equal(
    remainingToGraduate("100000000000", "300000000000"),
    200000000000n,
  );
  // Met or exceeded: nothing left to raise.
  assert.equal(remainingToGraduate("300000000000", "300000000000"), null);
  assert.equal(remainingToGraduate("400000000000", "300000000000"), null);
  assert.equal(remainingToGraduate(null, "300000000000"), null);
});
