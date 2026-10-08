import { index, onchainTable, primaryKey } from "ponder";

/** A pool the AMM created. Prices are token1 per token0 in BASE units; the app adjusts for decimals. */
export const pool = onchainTable(
  "pool",
  (t) => ({
    id: t.hex().primaryKey(),
    poolType: t.hex().notNull(),
    token0: t.hex().notNull(),
    token1: t.hex().notNull(),
    createdAt: t.integer().notNull(),
    lastPrice: t.real(),
    swaps: t.integer().notNull(),
  }),
  (table) => ({
    token0Index: index().on(table.token0),
    token1Index: index().on(table.token1),
  }),
);

/** One executed swap, as the price it traded at. */
export const swap = onchainTable(
  "swap",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    recipient: t.hex().notNull(),
    zeroForOne: t.boolean().notNull(),
    amountIn: t.bigint().notNull(),
    amountOut: t.bigint().notNull(),
    price: t.real().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    poolTimeIndex: index().on(table.poolId, table.timestamp),
  }),
);

/** Open/high/low/close of a pool's price over one bucket of one interval. */
export const candle = onchainTable(
  "candle",
  (t) => ({
    poolId: t.hex().notNull(),
    interval: t.integer().notNull(),
    start: t.integer().notNull(),
    open: t.real().notNull(),
    high: t.real().notNull(),
    low: t.real().notNull(),
    close: t.real().notNull(),
    volume0: t.bigint().notNull(),
    volume1: t.bigint().notNull(),
    trades: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.poolId, table.interval, table.start] }),
  }),
);
