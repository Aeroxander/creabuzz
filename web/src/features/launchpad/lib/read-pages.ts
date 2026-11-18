/**
 * Read a filter's matches in pages, newest first, a bounded number of pages deep.
 *
 * A relay answers a filter with at most `limit` records, the newest. Where a stranger can add records to the list (an
 * ask to join a project), one read of the newest `limit` can be filled with records the reader does not want, and the
 * one that matters is under them. So the read goes on with `until` set to the age of the oldest record seen, up to
 * `maxPages` pages, and says when it stopped with more left (`cut`). The page that ended the read (short, or empty)
 * means the list was read to its end.
 *
 * Pure and alias-free: `read-pages.test.mjs` drives it under `node --test`.
 */

interface Paged {
  id: string;
  created_at: number;
}

/** What `readPages` hands back: every record read (each once), and whether more may remain. */
export interface PagesRead<T> {
  events: T[];
  cut: boolean;
}

/**
 * `query` reads one page: the filter's records no newer than `until` (when given), newest first, at most `limit`.
 * `limit` and `maxPages` bound the read at `limit * maxPages` records.
 */
export async function readPages<T extends Paged>(
  query: (page: { until?: number; limit: number }) => Promise<readonly T[]>,
  options: { limit: number; maxPages: number },
): Promise<PagesRead<T>> {
  const seen = new Map<string, T>();
  let until: number | undefined;
  for (let page = 0; page < options.maxPages; page += 1) {
    const events = await query(
      until === undefined
        ? { limit: options.limit }
        : { until, limit: options.limit },
    );
    let fresh = 0;
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.set(event.id, event);
      fresh += 1;
    }
    // A short page is the end of the list.
    if (events.length < options.limit)
      return { events: [...seen.values()], cut: false };
    const oldest = Math.min(...events.map((event) => event.created_at));
    // A full page that adds nothing new (a whole page signed in one second) cannot be read past: say so rather than
    // ask again for the same page.
    if (fresh === 0) return { events: [...seen.values()], cut: true };
    until = oldest;
  }
  return { events: [...seen.values()], cut: true };
}
