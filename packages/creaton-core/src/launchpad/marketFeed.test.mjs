import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candlesUrl,
  indexerIntervalFor,
  marketCandles,
  parseCandles,
  parsePools,
  pickPool,
  poolsUrl,
  rebucket,
  sharesAreToken0,
  wholePrice,
} from "./marketFeed.ts";

const SHARES = "0x00000000000000000000000000000000000000aa";
const USDC = "0x00000000000000000000000000000000000000bb";
const OTHER = "0x00000000000000000000000000000000000000cc";
const POOL = `0x${"11".repeat(32)}`;
const POOL_2 = `0x${"22".repeat(32)}`;

const pool = (over = {}) => ({
  id: POOL,
  token0: SHARES,
  token1: USDC,
  swaps: 3,
  lastPrice: 1e-14,
  createdAt: 100,
  ...over,
});
const raw = (over = {}) => ({
  start: 1_700_000_100,
  open: 1e-14,
  high: 2e-14,
  low: 5e-15,
  close: 1.5e-14,
  volume0: "1000000000000000000000",
  volume1: "10000000",
  trades: 4,
  ...over,
});

test("a price is whole currency per whole Share, whichever token sorts first", () => {
  // $0.01 a Share with a 6-decimal currency: 1e4 base units per 1e18 base units = 1e-14.
  assert.ok(Math.abs(wholePrice(1e-14, true, 6) / 0.01 - 1) < 1e-9);
  // Shares second: the pool says Shares per currency, 1e14 base units.
  assert.ok(Math.abs(wholePrice(1e14, false, 6) / 0.01 - 1) < 1e-9);
  assert.equal(wholePrice(0, true, 6), null);
  assert.equal(wholePrice(Number.NaN, true, 6), null);
  assert.equal(wholePrice(-1, false, 6), null);
});

test("candles come out in whole prices, and the reciprocal pool swaps high and low", () => {
  const [first] = marketCandles(
    [parseCandles({ candles: [raw()] })[0]],
    true,
    6,
  );
  assert.equal(first.time, 1_700_000_100);
  assert.ok(Math.abs(first.open / 0.01 - 1) < 1e-9);
  assert.ok(Math.abs(first.high / 0.02 - 1) < 1e-9);
  assert.ok(Math.abs(first.low / 0.005 - 1) < 1e-9);
  // Currency volume is the token1 side when the Shares are token0.
  assert.equal(first.volume, 10);

  // The same trades seen from a pool that sorts the other way: prices are reciprocals of the Shares' price.
  const flipped = marketCandles(
    parseCandles({
      candles: [
        raw({
          open: 1e14,
          high: 2e14,
          low: 5e13,
          close: 6.5e13,
          volume0: "10000000",
          volume1: "1000000000000000000000",
        }),
      ],
    }),
    false,
    6,
  )[0];
  assert.ok(Math.abs(flipped.open / 0.01 - 1) < 1e-9);
  // 5e13 raw is the pool's LOWEST, which is the Shares' HIGHEST (1/5e13 > 1/2e14).
  assert.ok(flipped.high > flipped.low);
  assert.ok(Math.abs(flipped.high / 0.02 - 1) < 1e-9);
  assert.ok(Math.abs(flipped.low / 0.005 - 1) < 1e-9);
  assert.equal(flipped.volume, 10);
});

test("an indexer's answer is parsed defensively and nothing unreadable is guessed at", () => {
  assert.deepEqual(parsePools(null), []);
  assert.deepEqual(parsePools({ pools: "no" }), []);
  assert.deepEqual(
    parsePools({
      pools: [
        pool(),
        pool({ id: "0x12" }),
        pool({ token0: "nope" }),
        pool({ swaps: -1 }),
        null,
        "x",
      ],
    }).map((p) => p.id),
    [POOL],
  );
  assert.equal(
    parsePools({ pools: [pool({ lastPrice: -3 })] })[0].lastPrice,
    null,
  );
  assert.deepEqual(parseCandles({ candles: [raw({ open: 0 })] }), []);
  assert.deepEqual(parseCandles({ candles: [raw({ volume0: "1.5" })] }), []);
  assert.deepEqual(parseCandles({ candles: [raw({ start: 1.5 })] }), []);
  const parsed = parseCandles({
    candles: [raw({ start: 200 }), raw({ start: 100 })],
  });
  assert.deepEqual(
    parsed.map((c) => c.start),
    [100, 200],
  );
  assert.equal(typeof parsed[0].volume0, "bigint");
});

test("only the pool that trades the Shares against the sale's currency is this launch's price", () => {
  const pools = [
    pool({ id: POOL, swaps: 2 }),
    pool({ id: POOL_2, swaps: 9, token1: OTHER }),
    pool({
      id: `0x${"33".repeat(32)}`,
      swaps: 5,
      token0: USDC,
      token1: SHARES,
    }),
  ];
  assert.equal(pickPool(pools, SHARES, USDC)?.swaps, 5);
  assert.equal(pickPool(pools, SHARES, OTHER)?.id, POOL_2);
  assert.equal(pickPool([pool({ token1: OTHER })], SHARES, USDC), null);
  // Case does not matter, and the sides are told apart.
  assert.equal(
    pickPool(pools, SHARES.toUpperCase().replace("0X", "0x"), USDC)?.swaps,
    5,
  );
  assert.equal(sharesAreToken0(pool(), SHARES), true);
  assert.equal(
    sharesAreToken0(pool({ token0: USDC, token1: SHARES }), SHARES),
    false,
  );
});

test("candles merge into wider buckets without losing a high, a low or a trade", () => {
  const minute = (time, open, high, low, close, volume = 1) => ({
    time,
    open,
    high,
    low,
    close,
    volume,
    trades: 1,
  });
  const merged = rebucket(
    [
      minute(120, 2, 3, 1, 2.5),
      minute(60, 1, 2, 0.5, 2),
      minute(3600, 9, 9, 9, 9),
    ],
    3600,
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    time: 0,
    open: 1,
    high: 3,
    low: 0.5,
    close: 2.5,
    volume: 2,
    trades: 2,
  });
  assert.equal(merged[1].time, 3600);
  assert.deepEqual(rebucket([minute(1, 1, 1, 1, 1)], 0), []);
});

test("a chart asks for the widest indexed width that fits its timeframe", () => {
  assert.equal(indexerIntervalFor(30), 60);
  assert.equal(indexerIntervalFor(60), 60);
  assert.equal(indexerIntervalFor(900), 300);
  assert.equal(indexerIntervalFor(14_400), 3600);
  assert.equal(indexerIntervalFor(604_800), 86_400);
});

test("the indexer's addresses are built only from usable parts", () => {
  assert.equal(
    poolsUrl(
      "http://127.0.0.1:42069/",
      SHARES.toUpperCase().replace("0X", "0x"),
    ),
    `http://127.0.0.1:42069/pools?token=${SHARES}`,
  );
  assert.equal(poolsUrl("ftp://nope", SHARES), null);
  assert.equal(poolsUrl("not a url", SHARES), null);
  assert.equal(poolsUrl("http://x.test", "0x12"), null);
  assert.equal(
    candlesUrl("https://idx.test/api", POOL, 300, 50),
    `https://idx.test/api/candles?pool=${POOL}&interval=300&limit=50`,
  );
  assert.equal(candlesUrl("https://idx.test", "0x12", 60), null);
});
