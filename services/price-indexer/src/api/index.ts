import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { and, desc, eq, gte, lte, or } from "ponder";

import { isCandleInterval } from "../lib/price.ts";

/**
 * The read side the web app's $TICKER charts call. Everything is public market data, so any origin may read it; the
 * routes take a token or a pool and return bounded lists.
 *
 *   GET /pools?token=0x…                       the pools that trade this token, newest first
 *   GET /candles?pool=0x…&interval=3600&from=&to=&limit=
 *                                              the pool's candles, oldest first (prices are token1 per token0, in
 *                                              base units: the caller adjusts for decimals)
 */
const MAX_POOLS = 50;
const MAX_CANDLES = 1000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

const app = new Hono();
app.use("*", cors({ origin: "*", allowMethods: ["GET"] }));

app.get("/pools", async (c) => {
  const token = c.req.query("token");
  if (!token || !ADDRESS.test(token)) {
    return c.json(
      { error: "token must be an address (0x + 40 hex characters)" },
      400,
    );
  }
  const address = token.toLowerCase() as `0x${string}`;
  const rows = await db
    .select()
    .from(schema.pool)
    .where(or(eq(schema.pool.token0, address), eq(schema.pool.token1, address)))
    .orderBy(desc(schema.pool.createdAt))
    .limit(MAX_POOLS);
  return c.json({
    pools: rows.map((p) => ({
      id: p.id,
      poolType: p.poolType,
      token0: p.token0,
      token1: p.token1,
      createdAt: p.createdAt,
      lastPrice: p.lastPrice,
      swaps: p.swaps,
    })),
  });
});

app.get("/candles", async (c) => {
  const poolId = c.req.query("pool");
  const interval = Number(c.req.query("interval") ?? 3600);
  if (!poolId || !WORD.test(poolId)) {
    return c.json(
      { error: "pool must be a pool id (0x + 64 hex characters)" },
      400,
    );
  }
  if (!isCandleInterval(interval)) {
    return c.json(
      { error: "interval must be 60, 300, 3600 or 86400 seconds" },
      400,
    );
  }
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(
    Number(c.req.query("limit") ?? 200) || 200,
    MAX_CANDLES,
  );
  const id = poolId.toLowerCase() as `0x${string}`;
  const where = and(
    eq(schema.candle.poolId, id),
    eq(schema.candle.interval, interval),
    from ? gte(schema.candle.start, Number(from)) : undefined,
    to ? lte(schema.candle.start, Number(to)) : undefined,
  );
  // The newest `limit` candles, returned oldest first so a chart can draw them as they come.
  const rows = await db
    .select()
    .from(schema.candle)
    .where(where)
    .orderBy(desc(schema.candle.start))
    .limit(limit);
  rows.sort((a, b) => a.start - b.start);
  return c.json({
    interval,
    candles: rows.map((r) => ({
      start: r.start,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume0: r.volume0.toString(),
      volume1: r.volume1.toString(),
      trades: r.trades,
    })),
  });
});

export default app;
