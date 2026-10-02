/**
 * Candles for a launch's price chart.
 *
 * The only prices this relay holds for a launch are the ones people recorded:
 * each bid names the highest price its bidder would pay. Those are bucketed
 * into open/high/low/close candles with the bid budget as volume. They are bid
 * prices, not market trades, and the chart says so.
 *
 * Pure and alias-free: covered by `candles.test.mjs`.
 */

const Q96 = 2n ** 96n;

export interface PricePoint {
  /** Unix seconds. */
  time: number;
  /** Whole currency units per whole token. */
  price: number;
  /** Whole currency units committed at this price (0 when unknown). */
  volume: number;
}

export interface Candle {
  /** Start of the bucket, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A Q96 price (currency base units per token base unit) as whole currency per
 * whole token. Null when the value is not a positive integer.
 */
export function q96ToPrice(
  q96: string | null | undefined,
  currencyDecimals: number,
  tokenDecimals = 18,
): number | null {
  if (!q96 || !/^\d+$/.test(q96)) return null;
  const value = BigInt(q96);
  if (value === 0n) return null;
  // currency base units per whole token, with 6 extra digits kept for the ratio.
  const scaled = (value * 10n ** BigInt(tokenDecimals) * 1_000_000n) / Q96;
  const price = Number(scaled) / 1_000_000 / 10 ** currencyDecimals;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Whole currency from base units; null when unreadable. */
export function atomicToWhole(
  atomic: string | null | undefined,
  decimals: number,
): number | null {
  if (!atomic || !/^\d+$/.test(atomic)) return null;
  const value = Number(BigInt(atomic)) / 10 ** decimals;
  return Number.isFinite(value) ? value : null;
}

/** Bucket points into candles. Empty buckets produce no candle. */
export function bucketCandles(
  points: readonly PricePoint[],
  bucketSeconds: number,
): Candle[] {
  if (bucketSeconds <= 0) return [];
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const byBucket = new Map<number, Candle>();
  for (const point of sorted) {
    const start = Math.floor(point.time / bucketSeconds) * bucketSeconds;
    const existing = byBucket.get(start);
    if (!existing) {
      byBucket.set(start, {
        time: start,
        open: point.price,
        high: point.price,
        low: point.price,
        close: point.price,
        volume: point.volume,
      });
      continue;
    }
    existing.high = Math.max(existing.high, point.price);
    existing.low = Math.min(existing.low, point.price);
    existing.close = point.price;
    existing.volume += point.volume;
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

export const TIMEFRAMES = [
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
  { id: "15m", label: "15m", seconds: 900 },
  { id: "1h", label: "1H", seconds: 3_600 },
  { id: "4h", label: "4H", seconds: 14_400 },
  { id: "1d", label: "1D", seconds: 86_400 },
  { id: "1w", label: "1W", seconds: 604_800 },
] as const;

export type TimeframeId = (typeof TIMEFRAMES)[number]["id"];

/** The smallest timeframe that keeps the chart readable (under ~60 candles). */
export function defaultTimeframe(points: readonly PricePoint[]): TimeframeId {
  if (points.length === 0) return "1h";
  const times = points.map((p) => p.time);
  const span = Math.max(...times) - Math.min(...times);
  for (const frame of TIMEFRAMES) {
    if (span / frame.seconds <= 60) return frame.id;
  }
  return "1w";
}
