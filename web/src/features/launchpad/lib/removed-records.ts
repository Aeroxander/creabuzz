/**
 * What a founder took down: their own deletions of update records.
 *
 * The server stops serving a record its author deletes, and this app cannot change that. A deleted update takes its
 * promises and answers with it, and a deleted goal record takes that step of the goal. So the page cannot promise
 * that nothing was removed. What it can do is say how many update records the founder has deleted and when the last
 * one was, beside the totals those deletions may have changed.
 *
 * A deletion names the record it removes, not the project that record was about, and the record itself is gone. So
 * the count is of the founder's deleted update records on this server, whichever of their projects they were about;
 * reopening a help request is also done by deleting a record and is counted too. The page says so.
 *
 * Pure and alias-free: `removed-records.test.mjs` drives it under `node --test`.
 */

import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";

/** How many of the founder's deletions are read: the newest ones. */
export const REMOVED_READ_LIMIT = 500;

interface DeletionEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: readonly (readonly string[])[];
}

export interface RemovedRecords {
  /** How many update records the founder deleted, among the deletions read. */
  count: number;
  /** When the newest of those deletions was made, or null when there is none. */
  lastAt: number | null;
  /** The read was cut at its limit: there may be more. */
  atLeast: boolean;
}

/** The founder's deletions of update records among `events` (their own deletions, as read). */
export function removedRecords(
  events: readonly DeletionEvent[],
  founder: string,
): RemovedRecords {
  const removed = new Set<string>();
  let lastAt: number | null = null;
  for (const event of events) {
    if (event.kind !== 5 || event.pubkey !== founder) continue;
    // A deletion says which kind it removes; one that does not say is not counted as an update's.
    if (
      !event.tags.some(
        (tag) => tag[0] === "k" && tag[1] === String(KIND_LAUNCH_UPDATE),
      )
    )
      continue;
    const ids = event.tags
      .filter((tag) => tag[0] === "e" && typeof tag[1] === "string")
      .map((tag) => tag[1]);
    if (ids.length === 0) continue;
    for (const id of ids) removed.add(id);
    if (lastAt === null || event.created_at > lastAt) lastAt = event.created_at;
  }
  return {
    count: removed.size,
    lastAt,
    atLeast: events.length >= REMOVED_READ_LIMIT,
  };
}

/** "The founder has removed 2 update records, the last on 3 Nov 2026.", or null when none was removed. */
export function removedLine(
  removed: RemovedRecords,
  day: (at: number) => string,
): string | null {
  if (removed.count === 0 || removed.lastAt === null) return null;
  const many = removed.atLeast
    ? `at least ${removed.count} update records`
    : removed.count === 1
      ? "1 update record"
      : `${removed.count} update records`;
  return `The founder has removed ${many}, the last on ${day(removed.lastAt)}.`;
}
