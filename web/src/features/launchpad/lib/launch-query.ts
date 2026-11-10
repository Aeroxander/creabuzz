/**
 * The reads behind the list of every project, and their shape as the server sees it.
 *
 * Project records (kind 37001) are read on their own, a page at a time, newest first. They used to share one read of
 * the newest 500 records with updates, bids, proposals and receipts, so on a busy server a week of updates pushed
 * projects out of Discover while they were still stored. Now a project can only be pushed out of a page by other
 * projects, and the next page is one press away ("Show more projects").
 *
 * What is recorded against the projects (their news, and what their sale or DAO reported) is read beside them in two
 * bounded reads, so task and goal records, which share the update kind, never crowd out a receipt that says a sale
 * failed. A project's own page never depends on these: it reads its project by itself.
 *
 * Every filter names its kinds (a filter without kinds trips the server's p-gate) and a limit (an unbounded read is a
 * memory lever the reader controls). Pure, so `launch-query.test.mjs` pins the shapes and the paging, and
 * `launchpadQueryContract.test.mjs` pins that the hooks still use them: changing either alone fails a test.
 */

import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";
import {
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "../../../shared/constants/kinds.ts";

/** Project records read per page. */
export const PROJECT_PAGE_SIZE = 300;
/** At most this many pages are ever loaded: a bound on what one visit holds, said to the reader when reached. */
export const PROJECT_MAX_PAGES = 10;
/** Bounded read size for what is recorded against the projects, per read. */
export const LAUNCH_QUERY_LIMIT = 500;

/** One page of project records: the newest, or those signed at or before `until` (inclusive, as in NIP-01). */
export function projectPageFilter(until?: number): NostrFilter {
  return {
    kinds: [KIND_LAUNCH_RECORD],
    limit: PROJECT_PAGE_SIZE,
    ...(until === undefined ? {} : { until }),
  };
}

/** The projects' news: their update records, newest first. */
export function launchUpdatesFilter(): NostrFilter {
  return { kinds: [KIND_LAUNCH_UPDATE], limit: LAUNCH_QUERY_LIMIT };
}

/** What the projects' sales and DAOs reported: bids, proposals and receipts, newest first. */
export function launchReportsFilter(): NostrFilter {
  return {
    kinds: [KIND_LAUNCH_BID, KIND_LAUNCH_PROPOSAL, KIND_LAUNCH_RECEIPT],
    limit: LAUNCH_QUERY_LIMIT,
  };
}

/** The slice of a page of project records the paging reads. */
export interface ProjectPageShape {
  events: readonly { id: string; created_at: number }[];
}

/**
 * Where the next page starts, or null when there is none to ask for.
 *
 * A page shorter than the page size is the end. Otherwise the next page is asked from the oldest second of this one,
 * inclusive: records signed in that same second may not all have fit, and asking from one second earlier would lose
 * them for good. What comes back twice is dropped by id when the pages are joined. Two things stop the paging while
 * more may exist, and {@link projectListCut} then says so: a full page that brought nothing new (a whole page signed
 * in one second: there is no way further back), and the page bound.
 */
export function nextProjectPage(
  pages: readonly ProjectPageShape[],
): number | null {
  const last = pages[pages.length - 1];
  if (!last || last.events.length < PROJECT_PAGE_SIZE) return null;
  if (pages.length >= PROJECT_MAX_PAGES) return null;
  if (pages.length > 1 && !broughtNew(pages)) return null;
  return Math.min(...last.events.map((event) => event.created_at));
}

function broughtNew(pages: readonly ProjectPageShape[]): boolean {
  const seen = new Set<string>();
  for (const page of pages.slice(0, -1))
    for (const event of page.events) seen.add(event.id);
  return pages[pages.length - 1].events.some((event) => !seen.has(event.id));
}

/**
 * Whether the server may hold project records that no further page can reach: the last page came back full and
 * {@link nextProjectPage} has nowhere to go. Never true while "Show more projects" can still be pressed.
 */
export function projectListCut(pages: readonly ProjectPageShape[]): boolean {
  const last = pages[pages.length - 1];
  return (
    last !== undefined &&
    last.events.length >= PROJECT_PAGE_SIZE &&
    nextProjectPage(pages) === null
  );
}

/** Every record in the pages once, in the order read. */
export function joinProjectPages<E extends { id: string }>(
  pages: readonly { events: readonly E[] }[],
): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const page of pages)
    for (const event of page.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
    }
  return out;
}
