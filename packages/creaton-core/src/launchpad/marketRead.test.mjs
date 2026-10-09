import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeSwap } from "./marketActions.ts";
import {
  estimateTrade,
  findMarketPool,
  minimumOut,
  readPoolPrice,
  TOPIC_POOL_CREATED,
} from "./marketRead.ts";

const AMM = "0x00000000000000000000000000000000000000ff";
const SHARES = "0x00000000000000000000000000000000000000aa";
const USDC = "0x00000000000000000000000000000000000000bb";
const POOL_TYPE = "0x00000000000000000000000000000000000000cc";
const pad = (a) => `0x${a.slice(2).padStart(64, "0")}`;
// A pool id whose lowest two bytes carry a fee of 30 (0x1e) and whose spacing is 200 (0xc8).
const ID = `0x${"ab".repeat(28)}00c8001e`;
const wad = 10n ** 18n;

test("the pool event's topic is the exchange's, as cast keccak computes it", () => {
  // cast keccak "PoolCreated(address,address,address,bytes32,address)"
  assert.equal(TOPIC_POOL_CREATED.length, 66);
  assert.match(TOPIC_POOL_CREATED, /^0x[0-9a-f]{64}$/);
});

function chainWith(logsFor) {
  const asked = [];
  return {
    asked,
    async logs(filter) {
      asked.push(filter);
      return logsFor(filter);
    },
  };
}
const log = (poolId) => ({
  topics: [TOPIC_POOL_CREATED, pad(POOL_TYPE), pad(SHARES), pad(USDC)],
  data: `${poolId}${"00".repeat(32)}`,
});

test("the pool trading the Shares against the sale currency is found whichever token sorts first, with its fee", async () => {
  const first = chainWith((f) =>
    f.topics[2] === pad(SHARES) ? [log(ID)] : [],
  );
  const pool = await findMarketPool(first, {
    amm: AMM,
    sharesToken: SHARES,
    currency: USDC,
  });
  assert.deepEqual(pool, {
    id: ID,
    poolType: POOL_TYPE,
    sharesAreToken0: true,
    feeBps: 30,
  });
  assert.equal(first.asked.length, 2);

  const second = chainWith((f) =>
    f.topics[3] === pad(SHARES) ? [log(ID)] : [],
  );
  const flipped = await findMarketPool(second, {
    amm: AMM,
    sharesToken: SHARES,
    currency: USDC,
  });
  assert.equal(flipped.sharesAreToken0, false);

  const none = await findMarketPool(
    chainWith(() => []),
    { amm: AMM, sharesToken: SHARES, currency: USDC },
  );
  assert.equal(none, null);
  // A log that is not what it should be is never a pool.
  const garbled = await findMarketPool(
    chainWith((f) =>
      f.topics[2] === pad(SHARES) ? [{ topics: [], data: "0x12" }, null] : [],
    ),
    { amm: AMM, sharesToken: SHARES, currency: USDC },
  );
  assert.equal(garbled, null);
});

test("the pool's price is read as whole currency per Share, in either order", async () => {
  // sqrt(1e-14) * 2^96 for Shares first (a Share costs 0.01 in a 6-decimal currency)
  const sqrtFirst = BigInt(Math.round(Math.sqrt(1e-14) * 2 ** 96));
  const hexOf = (v) => `0x${v.toString(16).padStart(64, "0")}`;
  const pool = {
    id: ID,
    poolType: POOL_TYPE,
    sharesAreToken0: true,
    feeBps: 30,
  };
  const price = await readPoolPrice(
    { call: async () => hexOf(sqrtFirst) },
    { amm: AMM, pool, currencyDecimals: 6 },
  );
  assert.ok(Math.abs(price / 0.01 - 1) < 1e-6, String(price));
  // Shares second: the pool's price is Shares per currency, the reciprocal.
  const sqrtSecond = BigInt(Math.round(Math.sqrt(1e14) * 2 ** 96));
  const flipped = await readPoolPrice(
    { call: async () => hexOf(sqrtSecond) },
    {
      amm: AMM,
      pool: { ...pool, sharesAreToken0: false },
      currencyDecimals: 6,
    },
  );
  assert.ok(Math.abs(flipped / 0.01 - 1) < 1e-6, String(flipped));
  // A pool that does not exist reads as no price.
  assert.equal(
    await readPoolPrice(
      { call: async () => hexOf(0n) },
      { amm: AMM, pool, currencyDecimals: 6 },
    ),
    null,
  );
});

test("a trade is sized from the price and the fees, and a slippage allowance sets the least to accept", () => {
  // Buying with 1,000 of a 6-decimal currency at 0.01 each, 1.3% in fees: about 98,700 Shares.
  const buy = estimateTrade({
    side: "buy",
    amountIn: 1_000_000_000n,
    price: 0.01,
    currencyDecimals: 6,
    feeBps: 130,
  });
  assert.ok(Math.abs(Number(buy / wad) - 98_700) <= 1, String(buy));
  // Selling 10,000 Shares at 0.01 with the same fees: about 98.7.
  const sell = estimateTrade({
    side: "sell",
    amountIn: 10_000n * wad,
    price: 0.01,
    currencyDecimals: 6,
    feeBps: 130,
  });
  assert.ok(Math.abs(Number(sell) / 1e6 - 98.7) < 0.001, String(sell));
  assert.equal(
    estimateTrade({
      side: "buy",
      amountIn: 0n,
      price: 0.01,
      currencyDecimals: 6,
      feeBps: 0,
    }),
    0n,
  );
  assert.equal(
    estimateTrade({
      side: "buy",
      amountIn: 5n,
      price: 0,
      currencyDecimals: 6,
      feeBps: 0,
    }),
    0n,
  );
  assert.equal(minimumOut(1000n, 5), 950n);
  assert.equal(minimumOut(1000n, 0), 1000n);
  // Nobody can allow more than half to be lost, or less than nothing.
  assert.equal(minimumOut(1000n, 99), 500n);
  assert.equal(minimumOut(1000n, -5), 1000n);
});

test("the swap call is what cast encodes", () => {
  // cast calldata "singleSwap(...)" "(1000,0x…cc,5,0,3,0x…aa,0x…bb)" 0x1111… "(0x0,0)" "(0x0,0)" "(0x,0x,0x,0x)" 0x
  const data = encodeSwap({
    recipient: "0x00000000000000000000000000000000000000cc",
    tokenIn: "0x00000000000000000000000000000000000000aa",
    tokenOut: "0x00000000000000000000000000000000000000bb",
    amountIn: 5n,
    minOut: 3n,
    deadline: 1000,
    poolId: `0x${"11".repeat(32)}`,
  });
  assert.equal(
    data,
    "0x60d194b300000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000cc00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb1111111111111111111111111111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000002c0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.throws(() =>
    encodeSwap({
      ...{
        recipient: SHARES,
        tokenIn: SHARES,
        tokenOut: USDC,
        amountIn: 0n,
        minOut: 0n,
        deadline: 1,
        poolId: ID.padEnd(66, "0"),
      },
    }),
  );
});
