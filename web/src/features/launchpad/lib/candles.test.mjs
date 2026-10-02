import assert from "node:assert/strict";
import test from "node:test";

import {
  atomicToWhole,
  bucketCandles,
  defaultTimeframe,
  q96ToPrice,
} from "./candles.ts";

test("a Q96 floor reads as dollars per token", () => {
  // 0.01 USDC per token: the floor the seed and the launch page use.
  assert.equal(q96ToPrice("792281625140000", 6)?.toFixed(4), "0.0100");
});

test("junk prices read as nothing", () => {
  assert.equal(q96ToPrice(null, 6), null);
  assert.equal(q96ToPrice("0", 6), null);
  assert.equal(q96ToPrice("1.5", 6), null);
  assert.equal(q96ToPrice("-3", 6), null);
});

test("atomic amounts become whole currency", () => {
  assert.equal(atomicToWhole("5000000", 6), 5);
  assert.equal(atomicToWhole("x", 6), null);
});

test("points in one bucket become one candle with open, high, low, close", () => {
  const candles = bucketCandles(
    [
      { time: 3_700, price: 2, volume: 10 },
      { time: 3_650, price: 1, volume: 5 },
      { time: 5_000, price: 3, volume: 1 },
      { time: 7_300, price: 4, volume: 2 },
    ],
    3_600,
  );
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], {
    time: 3_600,
    open: 1,
    high: 3,
    low: 1,
    close: 3,
    volume: 16,
  });
  assert.equal(candles[1].time, 7_200);
});

test("empty buckets are skipped and a bad bucket size yields nothing", () => {
  assert.equal(bucketCandles([], 3_600).length, 0);
  assert.equal(bucketCandles([{ time: 1, price: 1, volume: 0 }], 0).length, 0);
});

test("the default timeframe keeps the chart under about sixty candles", () => {
  const day = 86_400;
  assert.equal(
    defaultTimeframe([
      { time: 0, price: 1, volume: 0 },
      { time: 10 * 3_600, price: 1, volume: 0 },
    ]),
    "15m",
  );
  assert.equal(
    defaultTimeframe([
      { time: 0, price: 1, volume: 0 },
      { time: 40 * day, price: 1, volume: 0 },
    ]),
    "1d",
  );
});
