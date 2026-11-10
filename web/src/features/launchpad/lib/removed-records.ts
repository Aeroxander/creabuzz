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
 * The founder's deletions are read by author, page by page to the end or a bound, so deletions of other things cannot
 * push these out of sight. A deletion need not say what kind of record it removes: those are counted apart, as
 * records that may have been updates. When the read did not reach the end the page says "at least", and when it found
 * none it says removals could not be checked, never that there were none.
 *
 * Pure and alias-free: `removed-records.test.mjs` drives it under `node --test`.
 */

import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";
import { EVIDENCE_QUERY_LIMIT } from "./evidence-query.ts";

interface DeletionEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: readonly (readonly string[])[];
}

/** The filter for one author's deletions, a page at a time. */
export function deletionsFilter(founder: string): {
  kinds: number[];
  authors: string[];
  limit: number;
} {
  // By author and kind only: those are what the server narrows by before its limit. A tag filter (`#k`) is applied
  // after it, so it would not keep unrelated deletions from filling a page, and it would leave out every deletion that
  // carries no `k` tag. The pages are read to the end (or to a bound) and sorted out here.
  return { kinds: [5], authors: [founder], limit: EVIDENCE_QUERY_LIMIT };
}

export interface RemovedRecords {
  /** How many update records the founder deleted (deletions that say they remove an update record). */
  count: number;
  /**
   * How many more records the founder deleted while saying nothing about their kind, or naming another kind. What a
   * deletion says it removes is not checked by anyone, so each may have been an update record.
   */
  unnamed: number;
  /** When the newest of those deletions (of either sort) was made, or null when there is none. */
  lastAt: number | null;
  /** The founder's deletions were read to the end. False when there are more than could be read. */
  complete: boolean;
}

/**
 * The founder's deletions of update records among `events` (their own deletions, as read), and whether that read
 * reached the end. Every deletion that names records by id counts, whatever kind it says it removes; one naming only a
 * project record (an `a` tag) is the project's removal, counted elsewhere.
 */
export function removedRecords(
  events: readonly DeletionEvent[],
  founder: string,
  complete: boolean,
): RemovedRecords {
  const removed = new Set<string>();
  const unnamed = new Set<string>();
  let lastAt: number | null = null;
  for (const event of events) {
    if (event.kind !== 5 || event.pubkey !== founder) continue;
    const ids = event.tags
      .filter((tag) => tag[0] === "e" && typeof tag[1] === "string")
      .map((tag) => tag[1]);
    if (ids.length === 0) continue;
    const kinds = event.tags
      .filter((tag) => tag[0] === "k")
      .map((tag) => tag[1]);
    // What a removal says it removes is its signer's word, and nothing checks it: one that names another kind (or
    // none, or another removal) may still have taken an update record away. So every removal is counted; the ones
    // that do not say "update record" are counted apart.
    const into = kinds.includes(String(KIND_LAUNCH_UPDATE)) ? removed : unnamed;
    for (const id of ids) into.add(id);
    if (lastAt === null || event.created_at > lastAt) lastAt = event.created_at;
  }
  // One named in both ways is an update record, counted once.
  for (const id of removed) unnamed.delete(id);
  return { count: removed.size, unnamed: unnamed.size, lastAt, complete };
}

const records = (n: number, what: string) =>
  n === 1 ? `1 ${what}` : `${n} ${what}s`;

/**
 * What the page says about removals, or null when the founder removed nothing and that is known.
 *
 * - "The founder has removed 2 update records, the last on 3 Nov 2026."
 * - with removals that do not say their kind: "... and 3 other records without saying what kind they were."
 * - only those: "The founder has removed 3 records without saying what kind they were. Some may have been updates."
 * - a read that did not reach the end says "at least", and with nothing found says removals could not be checked.
 */
export function removedLine(
  removed: RemovedRecords,
  day: (at: number) => string,
): string | null {
  const { count, unnamed, lastAt, complete } = removed;
  if (count + unnamed === 0 || lastAt === null)
    return complete
      ? null
      : "Whether the founder has removed update records could not be checked: they have more removals than could be read here.";
  const least = complete ? "" : "at least ";
  if (count === 0)
    return `The founder has removed ${least}${records(unnamed, "record")} that were not marked as updates, the last on ${day(lastAt)}. A removal can say any kind, so some may have been updates.`;
  const also =
    unnamed > 0
      ? `, and ${records(unnamed, "other record")} not marked as updates (a removal can say any kind)`
      : "";
  return `The founder has removed ${least}${records(count, "update record")}${also}. The last removal was on ${day(lastAt)}.`;
}

/**
 * The same, for a named team member who is not the founder: "Max has removed 2 update records, the last on …", or
 * that their removals could not all be read. Null when they removed nothing and that is known.
 */
export function memberRemovedLine(
  name: string,
  removed: RemovedRecords,
  day: (at: number) => string,
): string | null {
  const { count, unnamed, lastAt, complete } = removed;
  const total = count + unnamed;
  if (total === 0 || lastAt === null)
    return complete
      ? null
      : `Whether ${name} has removed records could not be checked: they have more removals than could be read here.`;
  return `${name} has removed ${complete ? "" : "at least "}${records(total, "record")}, the last on ${day(lastAt)}.`;
}
