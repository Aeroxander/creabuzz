/**
 * Reading project records for one author or one project, on their own.
 *
 * The list of every project is the newest 500 launchpad records of every kind, so on a busy server an older project
 * falls out of it while it is still stored. Three things must not depend on that list:
 *
 * - a project's page, which reads its project by id (and author, when the link names one);
 * - a new project's id, which must not be one its founder already has: publishing over it would REPLACE the older
 *   project's record, Shares and all. So the founder's own records are read page by page, to the end;
 * - publishing a project's record again, which starts from the record the server has now, not a remembered copy.
 *
 * Each read names the author and the kind (and the id, where there is one): those are what the server narrows by
 * before it applies its limit. A read that cannot finish fails; it never answers with part of the list.
 *
 * Pure and alias-free: `own-records.test.mjs` drives it under `node --test`.
 */

import { KIND_LAUNCH_RECORD } from "../../../shared/constants/kinds.ts";

interface RecordEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
}

/** A filter for project records, one page at a time (`until` is inclusive, as in NIP-01). */
export interface OwnRecordsFilter {
  kinds: number[];
  authors?: string[];
  "#d"?: string[];
  limit: number;
  until?: number;
}

/** Records read per page, and at most this many pages: far beyond any founder's projects, and a bound on the read. */
export const OWN_RECORDS_PAGE = 500;
const OWN_RECORDS_MAX_PAGES = 8;

const idOf = (event: RecordEvent) =>
  event.tags.find((tag) => tag[0] === "d")?.[1] ?? null;

/**
 * The id of every project record `author` has on the server, read to the end. Throws when the read cannot reach the
 * end: a new project is then not given an id at all, since a clash could not be ruled out.
 */
export async function readOwnLaunchIds<E extends RecordEvent>(
  author: string,
  query: (filter: OwnRecordsFilter) => Promise<readonly E[]>,
): Promise<string[]> {
  const seen = new Map<string, E>();
  let until: number | undefined;
  for (let page = 0; page < OWN_RECORDS_MAX_PAGES; page += 1) {
    const events = await query({
      kinds: [KIND_LAUNCH_RECORD],
      authors: [author],
      limit: OWN_RECORDS_PAGE,
      ...(until === undefined ? {} : { until }),
    });
    const before = seen.size;
    for (const event of events) seen.set(event.id, event);
    if (events.length < OWN_RECORDS_PAGE) {
      const ids = new Set<string>();
      for (const event of seen.values()) {
        const id = idOf(event);
        // Only the author's own records of this kind count, whatever the server sent back.
        if (id && event.pubkey === author && event.kind === KIND_LAUNCH_RECORD)
          ids.add(id);
      }
      return [...ids];
    }
    if (seen.size === before) break; // a full page of one second, read again: no way further back
    until = Math.min(...events.map((event) => event.created_at));
  }
  throw new Error(
    "Too many of your projects to read them all, so a new project cannot be given a name of its own here.",
  );
}

/** How many records one lookup by id asks for: an id has one record per author, and a link may not name the author. */
const BY_ID_LIMIT = 50;

/** The filter for one project's record: by id, and by author when known. */
export function recordByIdFilter(
  id: string,
  author: string | undefined,
): OwnRecordsFilter {
  return {
    kinds: [KIND_LAUNCH_RECORD],
    ...(author ? { authors: [author] } : {}),
    "#d": [id],
    limit: BY_ID_LIMIT,
  };
}

/**
 * `author`'s own record with this id as the server has it now (the newest, if it sent several), or null when there is
 * none. What comes back is checked again: a record by someone else, or with another id, is never taken for it.
 */
export function newestOwnRecord<E extends RecordEvent>(
  events: readonly E[],
  author: string,
  id: string,
): E | null {
  let newest: E | null = null;
  for (const event of events) {
    if (
      event.kind !== KIND_LAUNCH_RECORD ||
      event.pubkey !== author ||
      idOf(event) !== id
    )
      continue;
    if (
      !newest ||
      event.created_at > newest.created_at ||
      (event.created_at === newest.created_at && event.id > newest.id)
    )
      newest = event;
  }
  return newest;
}
