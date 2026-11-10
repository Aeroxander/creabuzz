/**
 * Which projects are listed: the one rule every list of projects uses (Discover, Home's side panel and Updates, the
 * launchpad, topics, tickers, a person's profile).
 *
 * A project is public from the moment it is started, and it is listed, unless:
 *
 * - its founder chose "Not listed yet" (`listing: "unlisted"` on their own record). The page still opens from its
 *   link and says so; nothing lists it;
 * - it is a sale that is still being set up: a draft that already names sale terms. Those terms can still change, so
 *   listing it would show a maybe as an offer. A draft with no sale terms at all (a project started with the short
 *   form, an idea) has nothing unfinished about it, and is listed;
 * - this build does not offer what it is (`listedHere`: a contributor-only build never lists a raise).
 *
 * A project its founder removed is not in the records at all (`buildLaunches` drops it), so it is never asked about.
 *
 * Pure and alias-free: `listing.test.mjs` drives it under `node --test`.
 */

import { listedHere, type ListedRecord } from "./contributor-only.ts";
import { isIdea } from "./idea.ts";

/** The slice of a project record the rule reads. */
export interface ListingRecord extends ListedRecord {
  listing?: "unlisted" | null;
}

/** Whether the founder chose "Not listed yet". */
export function notListedYet(record: { listing?: "unlisted" | null }): boolean {
  return record.listing === "unlisted";
}

/**
 * Whether a project belongs in a list of projects. `stage` is the stage in effect (`effectiveStage`), which can be
 * past "draft" while the record still says draft.
 */
export function listedProject(
  record: ListingRecord,
  stage: ListingRecord["stage"],
  raises: boolean,
): boolean {
  if (notListedYet(record)) return false;
  if (stage === "draft" && !isIdea(record)) return false;
  return listedHere(record, raises);
}

/** Said on the page of a project that is not listed, to everyone who opens it. */
export const NOT_LISTED_LINE =
  "Not listed yet. Only people with the link can find this project.";
