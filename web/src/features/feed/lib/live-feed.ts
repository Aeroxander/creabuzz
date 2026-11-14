/**
 * What makes Home's feed feel live without moving under the reader: records that arrive after the page was shown
 * wait behind an "N new" pill and slide in when it is pressed. Older records (a "Show older" page) are never "new".
 *
 * Pure and alias-free: `live-feed.test.mjs` drives it under `node --test`.
 */

interface Item {
  id: string;
  at: number;
}

/** How often the feed asks the server again, in milliseconds. */
export const LIVE_POLL_MS = 30_000;

/**
 * The items to show now and the ones waiting behind the pill. `shown` is every id the reader has been shown (null
 * before the first read: then everything is shown). An item is held back only when it was not shown before and is
 * newer than the newest one that was: a page of older records joins the list at once.
 */
export function splitLive<T extends Item>(
  items: readonly T[],
  shown: ReadonlySet<string> | null,
): { visible: T[]; waiting: T[] } {
  if (shown === null) return { visible: [...items], waiting: [] };
  const newestShown = Math.max(
    0,
    ...items.filter((item) => shown.has(item.id)).map((item) => item.at),
  );
  const waiting = items.filter(
    (item) => !shown.has(item.id) && item.at > newestShown,
  );
  const held = new Set(waiting.map((item) => item.id));
  return { visible: items.filter((item) => !held.has(item.id)), waiting };
}

/** "1 new record" / "4 new records": the pill's words. */
export function newPillWords(count: number): string {
  return count === 1 ? "1 new record" : `${count} new records`;
}
