/**
 * The arithmetic of turning swaps into candles. Pure, so `price.test.ts` drives it without a chain.
 *
 * A pool's price is token1 per token0 in BASE units. A swap that pays token0 in and takes token1 out traded at
 * out/in; one that pays token1 in traded at in/out. The price here is the price the trader actually got, so it
 * includes the fees the swap paid.
 */

/** The candle widths the indexer keeps, in seconds: one minute, five minutes, an hour, a day. */
export const CANDLE_INTERVALS = [60, 300, 3600, 86400] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export function isCandleInterval(value: number): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly number[]).includes(value);
}

/** The price one swap traded at, or null for a swap that moved nothing on one side (it has no price). */
export function swapPrice(
  zeroForOne: boolean,
  amountIn: bigint,
  amountOut: bigint,
): number | null {
  if (amountIn <= 0n || amountOut <= 0n) return null;
  const price = zeroForOne
    ? Number(amountOut) / Number(amountIn)
    : Number(amountIn) / Number(amountOut);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** The start of the bucket `timestamp` falls in. */
export function bucketStart(timestamp: number, interval: number): number {
  return timestamp - (timestamp % interval);
}

export interface CandleRow {
  open: number;
  high: number;
  low: number;
  close: number;
  volume0: bigint;
  volume1: bigint;
  trades: number;
}

/** A swap's volume in each token: the side paid in is the amount in, the other is the amount out. */
export function swapVolumes(
  zeroForOne: boolean,
  amountIn: bigint,
  amountOut: bigint,
): { volume0: bigint; volume1: bigint } {
  return zeroForOne
    ? { volume0: amountIn, volume1: amountOut }
    : { volume0: amountOut, volume1: amountIn };
}

/** The candle after one more swap: it starts at the swap's price, or keeps its open and widens its range. */
export function foldCandle(
  current: CandleRow | null,
  price: number,
  volume0: bigint,
  volume1: bigint,
): CandleRow {
  if (!current) {
    return {
      open: price,
      high: price,
      low: price,
      close: price,
      volume0,
      volume1,
      trades: 1,
    };
  }
  return {
    open: current.open,
    high: Math.max(current.high, price),
    low: Math.min(current.low, price),
    close: price,
    volume0: current.volume0 + volume0,
    volume1: current.volume1 + volume1,
    trades: current.trades + 1,
  };
}
