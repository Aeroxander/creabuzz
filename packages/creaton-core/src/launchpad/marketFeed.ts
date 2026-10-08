/**
 * Market prices for a project's Shares, from the price indexer (`services/price-indexer`).
 *
 * The indexer reports a pool's prices as token1 per token0 in BASE units, and which token sorts first is decided by
 * the addresses, so a screen cannot show them as they come. This turns an indexer answer into whole currency per whole
 * Share, with the Shares' side and the currency's decimals applied. Everything an indexer returns is untrusted data to
 * the page, so it is parsed defensively and anything unreadable is dropped, never guessed at.
 *
 * Pure and alias-free: covered by `marketFeed.test.mjs`.
 */

/** The candle widths the indexer keeps, in seconds. */
export const INDEXER_INTERVALS = [60, 300, 3600, 86400] as const;

/** The largest width the indexer keeps that does not exceed `seconds` (the finest one when it is below them all). */
export function indexerIntervalFor(seconds: number): number {
  let chosen: number = INDEXER_INTERVALS[0];
  for (const interval of INDEXER_INTERVALS) {
    if (interval <= seconds) chosen = interval;
  }
  return chosen;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

export interface IndexedPool {
  id: string;
  token0: string;
  token1: string;
  swaps: number;
  /** Token1 per token0, base units; null until the first trade. */
  lastPrice: number | null;
  createdAt: number;
}

export interface IndexedCandle {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume0: bigint;
  volume1: bigint;
  trades: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** The pools in an indexer's `/pools` answer; entries that are not well formed are left out. */
export function parsePools(json: unknown): IndexedPool[] {
  if (!isRecord(json) || !Array.isArray(json.pools)) return [];
  return json.pools.flatMap((raw): IndexedPool[] => {
    if (!isRecord(raw)) return [];
    const { id, token0, token1, swaps, lastPrice, createdAt } = raw;
    if (
      typeof id !== "string" ||
      !WORD.test(id) ||
      typeof token0 !== "string" ||
      !ADDRESS.test(token0) ||
      typeof token1 !== "string" ||
      !ADDRESS.test(token1) ||
      typeof swaps !== "number" ||
      !Number.isInteger(swaps) ||
      swaps < 0
    ) {
      return [];
    }
    return [
      {
        id: id.toLowerCase(),
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        swaps,
        lastPrice: positive(lastPrice) ? lastPrice : null,
        createdAt: typeof createdAt === "number" ? createdAt : 0,
      },
    ];
  });
}

/** The candles in an indexer's `/candles` answer, oldest first; malformed entries are left out. */
export function parseCandles(json: unknown): IndexedCandle[] {
  if (!isRecord(json) || !Array.isArray(json.candles)) return [];
  const out = json.candles.flatMap((raw): IndexedCandle[] => {
    if (!isRecord(raw)) return [];
    const { start, open, high, low, close, volume0, volume1, trades } = raw;
    if (
      typeof start !== "number" ||
      !Number.isInteger(start) ||
      !positive(open) ||
      !positive(high) ||
      !positive(low) ||
      !positive(close) ||
      typeof volume0 !== "string" ||
      !/^\d+$/.test(volume0) ||
      typeof volume1 !== "string" ||
      !/^\d+$/.test(volume1) ||
      typeof trades !== "number"
    ) {
      return [];
    }
    return [
      {
        start,
        open,
        high,
        low,
        close,
        volume0: BigInt(volume0),
        volume1: BigInt(volume1),
        trades,
      },
    ];
  });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The pool that trades exactly the Shares against the sale's currency, the busiest one when there are several. A pool
 * of the Shares against anything else is not this launch's price, so it is never picked.
 */
export function pickPool(
  pools: readonly IndexedPool[],
  shares: string,
  currency: string,
): IndexedPool | null {
  const s = shares.toLowerCase();
  const c = currency.toLowerCase();
  const matching = pools.filter(
    (p) =>
      (p.token0 === s && p.token1 === c) || (p.token0 === c && p.token1 === s),
  );
  matching.sort((a, b) => b.swaps - a.swaps || b.createdAt - a.createdAt);
  return matching[0] ?? null;
}

export function sharesAreToken0(pool: IndexedPool, shares: string): boolean {
  return pool.token0 === shares.toLowerCase();
}

/**
 * A pool price (token1 per token0, base units) as whole currency per whole Share. Null when it is not a usable price.
 */
export function wholePrice(
  raw: number,
  sharesToken0: boolean,
  currencyDecimals: number,
  sharesDecimals = 18,
): number | null {
  if (!positive(raw)) return null;
  const perBase = sharesToken0 ? raw : 1 / raw;
  const price = (perBase * 10 ** sharesDecimals) / 10 ** currencyDecimals;
  return positive(price) ? price : null;
}

/** A candle in whole currency per whole Share, with volume in whole currency. */
export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

/**
 * The indexer's candles for a pool as the chart draws them. When the Shares sort second the pool's price is the
 * reciprocal of theirs, which swaps a candle's highest and lowest.
 */
export function marketCandles(
  candles: readonly IndexedCandle[],
  sharesToken0: boolean,
  currencyDecimals: number,
): MarketCandle[] {
  return candles.flatMap((c): MarketCandle[] => {
    const open = wholePrice(c.open, sharesToken0, currencyDecimals);
    const close = wholePrice(c.close, sharesToken0, currencyDecimals);
    const a = wholePrice(c.high, sharesToken0, currencyDecimals);
    const b = wholePrice(c.low, sharesToken0, currencyDecimals);
    if (open === null || close === null || a === null || b === null) return [];
    const currencyVolume = sharesToken0 ? c.volume1 : c.volume0;
    return [
      {
        time: c.start,
        open,
        close,
        high: Math.max(a, b),
        low: Math.min(a, b),
        volume: Number(currencyVolume) / 10 ** currencyDecimals,
        trades: c.trades,
      },
    ];
  });
}

/** Merge candles into wider buckets (open of the first, close of the last, widest range, summed volume). */
export function rebucket(
  candles: readonly MarketCandle[],
  bucketSeconds: number,
): MarketCandle[] {
  if (bucketSeconds <= 0) return [];
  const byBucket = new Map<number, MarketCandle>();
  for (const c of [...candles].sort((x, y) => x.time - y.time)) {
    const start = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    const existing = byBucket.get(start);
    if (!existing) {
      byBucket.set(start, { ...c, time: start });
      continue;
    }
    existing.high = Math.max(existing.high, c.high);
    existing.low = Math.min(existing.low, c.low);
    existing.close = c.close;
    existing.volume += c.volume;
    existing.trades += c.trades;
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

/** `/pools?token=…` on an indexer, or null when the base URL is not a plain http(s) URL. */
export function poolsUrl(base: string, token: string): string | null {
  const root = indexerRoot(base);
  return root && ADDRESS.test(token)
    ? `${root}/pools?token=${token.toLowerCase()}`
    : null;
}

/** `/candles?…` on an indexer for a pool, or null when the base URL or the pool id is unusable. */
export function candlesUrl(
  base: string,
  pool: string,
  interval: number,
  limit = 500,
): string | null {
  const root = indexerRoot(base);
  if (!root || !WORD.test(pool)) return null;
  return `${root}/candles?pool=${pool.toLowerCase()}&interval=${interval}&limit=${limit}`;
}

function indexerRoot(base: string): string | null {
  try {
    const url = new URL(base.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
