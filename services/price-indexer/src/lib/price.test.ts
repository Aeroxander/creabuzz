import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bucketStart,
  CANDLE_INTERVALS,
  foldCandle,
  isCandleInterval,
  swapPrice,
  swapVolumes,
} from "./price.ts";

test("a swap's price is token1 per token0 whichever way it went", () => {
  // Pay 1,000 token0, take 10 token1: 0.01 token1 per token0.
  assert.equal(swapPrice(true, 1000n, 10n), 0.01);
  // Pay 10 token1, take 1,000 token0: the same price.
  assert.equal(swapPrice(false, 10n, 1000n), 0.01);
});

test("a price survives amounts far past what a double holds exactly", () => {
  // 96,867 Shares (18 decimals) bought with 1,000 USDC (6 decimals): the ratio is what matters.
  const shares = 96_867_493_883_820_293_187_241n;
  const usdc = 1_000_000_000n;
  const price = swapPrice(false, usdc, shares);
  assert.ok(price !== null);
  assert.ok(Math.abs(price / 1.0323e-14 - 1) < 0.001, String(price));
});

test("a swap that moved nothing on a side has no price", () => {
  assert.equal(swapPrice(true, 0n, 5n), null);
  assert.equal(swapPrice(true, 5n, 0n), null);
});

test("candles bucket by their interval", () => {
  assert.equal(bucketStart(1_700_000_123, 60), 1_700_000_100);
  assert.equal(bucketStart(1_700_000_123, 3600), 1_699_999_200);
  assert.equal(bucketStart(1_700_000_100, 60), 1_700_000_100);
  assert.deepEqual([...CANDLE_INTERVALS], [60, 300, 3600, 86400]);
  assert.equal(isCandleInterval(300), true);
  assert.equal(isCandleInterval(7), false);
});

test("volume is the amount paid in on one side and taken out on the other", () => {
  assert.deepEqual(swapVolumes(true, 1000n, 10n), {
    volume0: 1000n,
    volume1: 10n,
  });
  assert.deepEqual(swapVolumes(false, 10n, 1000n), {
    volume0: 1000n,
    volume1: 10n,
  });
});

test("a candle opens at its first price and widens, closes at the last, and adds up volume", () => {
  let candle = foldCandle(null, 1, 100n, 1n);
  assert.deepEqual(candle, {
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume0: 100n,
    volume1: 1n,
    trades: 1,
  });
  candle = foldCandle(candle, 3, 50n, 2n);
  candle = foldCandle(candle, 0.5, 25n, 3n);
  candle = foldCandle(candle, 2, 25n, 4n);
  assert.deepEqual(candle, {
    open: 1,
    high: 3,
    low: 0.5,
    close: 2,
    volume0: 200n,
    volume1: 10n,
    trades: 4,
  });
});
