/**
 * The market board: what each project's Shares have done lately, from the price service's hourly candles.
 *
 * Everything here is arithmetic over traded prices (a price is the price a swap actually got), so the board says what
 * happened and nothing about what will. A project that has not traded has no figures, not zeros. Sorting never guesses
 * either: projects without figures go to the end, whichever way the board is sorted.
 *
 * Alias-free and pure: covered by `market-board.test.mjs`.
 */

/** One candle of traded prices, as the price service keeps them (whole currency per Share, volume in whole currency). */
export interface BoardCandle {
  /** Start of the candle, unix seconds. */
  time: number;
  open: number;
  close: number;
  volume: number;
  trades: number;
}

export interface BoardStats {
  /** The last traded price. */
  price: number;
  /** How far the price moved over the last 24 hours, as a fraction (0.12 = up 12%). Null when it cannot be told. */
  change24h: number | null;
  /** Whole currency traded over the last 24 hours. */
  volume24h: number;
  /** Closing prices of the most recent candles, oldest first, for a small chart. */
  points: number[];
  /** Start of the latest candle that had a trade, unix seconds. */
  lastTradeAt: number;
}

const DAY = 24 * 60 * 60;

/** How many closing prices the small chart keeps. */
export const SPARKLINE_POINTS = 24;

/**
 * The board's figures for one project from its candles (oldest first), or null when it has not traded.
 *
 * The 24-hour move is measured from the last price at or before 24 hours ago. A project that began trading less than
 * a day ago is measured from its first trade instead, so a brand-new market shows how it has moved since it opened
 * rather than nothing; one with a single price and no move says 0, never a made-up number.
 */
export function boardStats(
  candles: readonly BoardCandle[],
  nowSecs: number,
): BoardStats | null {
  const traded = candles
    .filter((c) => c.trades > 0 && c.close > 0 && c.open > 0)
    .sort((a, b) => a.time - b.time);
  const last = traded[traded.length - 1];
  if (!last) return null;

  const cutoff = nowSecs - DAY;
  const before = traded.filter((c) => c.time < cutoff);
  const reference =
    before.length > 0 ? before[before.length - 1].close : traded[0].open;
  const change24h = reference > 0 ? (last.close - reference) / reference : null;

  return {
    price: last.close,
    change24h,
    volume24h: traded
      .filter((c) => c.time >= cutoff)
      .reduce((total, c) => total + c.volume, 0),
    points: traded.slice(-SPARKLINE_POINTS).map((c) => c.close),
    lastTradeAt: last.time,
  };
}

export type BoardSort = "volume" | "change" | "newest";

export const BOARD_SORTS: readonly { id: BoardSort; label: string }[] = [
  { id: "volume", label: "Most traded" },
  { id: "change", label: "Biggest move today" },
  { id: "newest", label: "Newest" },
];

export interface BoardRow {
  stats: BoardStats | null;
  /** When the project was published, unix seconds. */
  createdAt: number;
}

/**
 * The rows in the order asked for. "Biggest move" is the size of the move, up or down. Rows with no figures come last,
 * in the order they arrived (newest first for "newest"), so a project is never ranked on numbers it does not have.
 */
export function sortBoard<T extends BoardRow>(
  rows: readonly T[],
  sort: BoardSort,
): T[] {
  const withFigures = rows.filter((row) => row.stats !== null);
  const without = rows.filter((row) => row.stats === null);
  const key = (row: T): number => {
    const stats = row.stats as BoardStats;
    if (sort === "volume") return stats.volume24h;
    if (sort === "change") return Math.abs(stats.change24h ?? 0);
    return row.createdAt;
  };
  const byKey = (a: T, b: T) => key(b) - key(a);
  if (sort === "newest") {
    return [...rows].sort((a, b) => b.createdAt - a.createdAt);
  }
  return [
    ...withFigures.sort(byKey),
    ...without.sort((a, b) => b.createdAt - a.createdAt),
  ];
}

/** "+12.3%", "−4.0%" or "0.0%"; a missing figure is a dash. */
export function formatChange(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return "–";
  const percent = change * 100;
  if (Math.abs(percent) < 0.05) return "0.0%";
  const body = `${Math.abs(percent).toFixed(1)}%`;
  return percent > 0 ? `+${body}` : `−${body}`;
}

/** A price with enough digits to tell two nearby prices apart, and no more. */
export function formatBoardPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "–";
  if (price >= 1000) return price.toFixed(0);
  if (price >= 1) return price.toFixed(2);
  return price.toPrecision(3);
}

/** A volume in whole currency: "1.2k", "3.4M"; small amounts keep their cents. */
export function formatVolume(volume: number): string {
  if (!Number.isFinite(volume) || volume <= 0) return "0";
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}k`;
  if (volume >= 10) return volume.toFixed(0);
  return volume.toPrecision(2);
}
