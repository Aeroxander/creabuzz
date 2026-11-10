/**
 * Where a launch's evidence is fetched from.
 *
 * The directory read is bounded (the newest 500 events of every kind), so on a busy server an old claim's evidence falls
 * out of it while it is still stored, and a reviewer loses the Approve button for a claim that is waiting on them. The
 * evidence is therefore read for the launch on its own: only its updates, whatever else the server holds. One page of
 * 500 is not enough on its own either: a busy project can post more than 500 updates, and a claim's evidence behind them
 * would fall out again. So the launch's updates are read a page at a time, newest to oldest, up to a bound, and when the
 * bound is reached the read says it is incomplete instead of looking finished.
 *
 * Pure and alias-free: `evidence-query.test.mjs` drives it under `node --test`.
 */

import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";
import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";

/** Bounded read size for one launch's updates: far more than a launch has claims. */
export const EVIDENCE_QUERY_LIMIT = 500;

/** The filter for a launch's updates, by the launch coordinate every one of them names in its `a` tag. */
export function evidenceQueryFilter(launchCoordinate: string): NostrFilter {
  return {
    kinds: [KIND_LAUNCH_UPDATE],
    "#a": [launchCoordinate],
    limit: EVIDENCE_QUERY_LIMIT,
  };
}

/** How many pages of a launch's updates are read at most: 10 pages of 500 is more than any launch posts. */
export const EVIDENCE_MAX_PAGES = 10;

/**
 * The filter for one author's update records, whatever project they are about. Naming the author is what the server
 * narrows by before it applies its limit, so nobody else's records can crowd these out of a page; the caller keeps the
 * ones about its project.
 */
export function authorUpdatesFilter(author: string): NostrFilter {
  return {
    kinds: [KIND_LAUNCH_UPDATE],
    authors: [author],
    limit: EVIDENCE_QUERY_LIMIT,
  };
}

/**
 * Read all of a launch's updates a page at a time, newest first, each page starting where the last stopped. `complete`
 * is true only when the history was read to its end. It is false when the page bound was reached, or when a page could
 * not be walked past (a whole page of updates in one second cannot be paged by time): the caller must then say the
 * evidence it found may not be all there is.
 */
export function readEvidenceEvents<
  E extends { id: string; created_at: number },
>(
  fetchPage: (filter: NostrFilter) => Promise<readonly E[]>,
  launchCoordinate: string,
): Promise<{ events: E[]; complete: boolean }> {
  return readPaged(fetchPage, () => evidenceQueryFilter(launchCoordinate));
}

/**
 * Read every update record one author signed, a page at a time, the same way. Used for a project's goals and its
 * founder's promises: read by author, their completeness cannot be taken away by other people's records about the
 * project, however many those are.
 */
export function readAuthorUpdates<E extends { id: string; created_at: number }>(
  fetchPage: (filter: NostrFilter) => Promise<readonly E[]>,
  author: string,
): Promise<{ events: E[]; complete: boolean }> {
  return readPaged(fetchPage, () => authorUpdatesFilter(author));
}

async function readPaged<E extends { id: string; created_at: number }>(
  fetchPage: (filter: NostrFilter) => Promise<readonly E[]>,
  makeFilter: () => NostrFilter,
): Promise<{ events: E[]; complete: boolean }> {
  const seen = new Map<string, E>();
  let until: number | undefined;
  for (let page = 0; page < EVIDENCE_MAX_PAGES; page += 1) {
    const filter = makeFilter();
    if (until !== undefined) filter.until = until;
    const events = await fetchPage(filter);
    let fresh = 0;
    for (const event of events) {
      if (!seen.has(event.id)) {
        seen.set(event.id, event);
        fresh += 1;
      }
    }
    // A short page is the end of the history.
    if (events.length < EVIDENCE_QUERY_LIMIT) {
      return { events: [...seen.values()], complete: true };
    }
    const oldest = Math.min(...events.map((event) => event.created_at));
    // `until` includes its own second, so the oldest update comes back once more: a page of nothing new, or one that did
    // not move back in time, cannot be walked past.
    if (fresh === 0 || (until !== undefined && oldest >= until)) {
      return { events: [...seen.values()], complete: false };
    }
    until = oldest;
  }
  return { events: [...seen.values()], complete: false };
}
