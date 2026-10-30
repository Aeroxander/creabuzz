/**
 * Which launch records their authors took off the list, kept apart from `models.ts` (which applies them in
 * `buildLaunches`) so a new project can check it does not reuse a removed one.
 */
import type { NostrEvent } from "@/shared/lib/nostr-client";

import { KIND_LAUNCH_RECORD } from "../../../shared/constants/kinds.ts";

/**
 * The launch records an author took off the list (NIP-09 kind 5 naming `37001:<author>:<id>` in an `a` tag), by
 * coordinate, with the time of the latest removal. Only the author's own removals count: a deletion from anyone else
 * names nothing of theirs.
 */
export function launchRemovals(events: NostrEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 5) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "a" || !tag[1]) continue;
      const [kind, author] = tag[1].split(":");
      if (kind !== String(KIND_LAUNCH_RECORD) || author !== event.pubkey)
        continue;
      out.set(tag[1], Math.max(out.get(tag[1]) ?? 0, event.created_at));
    }
  }
  return out;
}

/** The ids of `author`'s launch records that were ever taken off the list: a new project must not reuse one. */
export function removedLaunchIds(
  removals: ReadonlyMap<string, number>,
  author: string,
): string[] {
  const prefix = `${KIND_LAUNCH_RECORD}:${author}:`;
  return [...removals.keys()]
    .filter((coordinate) => coordinate.startsWith(prefix))
    .map((coordinate) => coordinate.slice(prefix.length));
}

/** Removals read per page, and at most this many pages: far beyond any founder's history, and a bound on the read. */
export const REMOVALS_PAGE = 500;
export const REMOVALS_MAX_PAGES = 8;

/** A filter for an author's deletions, one page at a time (`until` is inclusive, as in NIP-01). */
export interface RemovalsFilter {
  kinds: number[];
  authors: string[];
  limit: number;
  until?: number;
}

/**
 * Every launch record `author` ever took off the list. Their deletions of anything else (a message, a post) share the
 * same kind, so the newest page alone could be all of those and push an old removal out of sight, and a new project
 * would then take the removed one's id. So the deletions are read page by page, older each time, until a page comes back
 * short. The relay applies a tag filter only after its limit, so asking for `#k` or `#a` would not help, and removals
 * published before they carried a `k` tag would be missed. Past the bound it fails, never answers with part of the list.
 */
export async function readRemovedLaunchIds(
  author: string,
  query: (filter: RemovalsFilter) => Promise<NostrEvent[]>,
): Promise<string[]> {
  const seen = new Map<string, NostrEvent>();
  let until: number | undefined;
  for (let page = 0; page < REMOVALS_MAX_PAGES; page += 1) {
    const events = await query({
      kinds: [5],
      authors: [author],
      limit: REMOVALS_PAGE,
      ...(until === undefined ? {} : { until }),
    });
    const before = seen.size;
    for (const event of events) seen.set(event.id, event);
    if (events.length < REMOVALS_PAGE) {
      return removedLaunchIds(launchRemovals([...seen.values()]), author);
    }
    if (seen.size === before) break; // a full page of one second, read again: no way further back
    until = Math.min(...events.map((event) => event.created_at));
  }
  throw new Error(
    "Too many of your deletions to read them all, so a new project cannot be given a name of its own here.",
  );
}
