/**
 * What the right rail lists: a handful of projects, trending posts, hashtags and people, each with a "See all" link to
 * its full page. Pure, so `rail.test.mjs` drives it under `node --test` without a server.
 */

import { listedHere } from "../../launchpad/lib/contributor-only.ts";
import {
  helpCandidates,
  type OpenHelpRequest,
} from "../../launchpad/lib/help-request.ts";
import { isIdea } from "../../launchpad/lib/idea.ts";
import { effectiveStage, type Launch } from "../../launchpad/models.ts";

/** How many rows each rail block shows before its "See all". */
export const RAIL_LIMITS = {
  projects: 4,
  /** Open requests for help under the projects: a few, newest first. */
  helpRequests: 3,
  /** How many requests are checked for "Help found" to find those few: some spare, for the ones since closed. */
  helpCandidates: 12,
  posts: 3,
  /**
   * How many trending posts the rail reads by id to find `posts` to show: a few spare, for the authors the reader
   * muted. Not Explore's full thirty, so the rail on every social page asks the server for a handful, not a page.
   */
  postsRead: 9,
  hashtags: 5,
  people: 3,
} as const;

/**
 * The newest projects people can open: what Discover lists (same records, same rules), minus the ones that are over.
 * A draft is not public yet, except an idea in a contributor-only build, which Discover lists on purpose; a failed
 * project is over; a contributor-only build leaves out a raise another build published to the same server.
 */
export function railProjects(
  launches: readonly Launch[],
  raises: boolean,
  limit: number = RAIL_LIMITS.projects,
): Launch[] {
  return launches
    .filter((launch) => listed(launch, raises))
    .sort(
      (a, b) =>
        b.record.createdAt - a.record.createdAt ||
        (a.record.id < b.record.id ? -1 : 1),
    )
    .slice(0, limit);
}

/** Whether Discover lists a project: public, not over, and offered by this build. */
function listed(launch: Launch, raises: boolean): boolean {
  const stage = effectiveStage(launch);
  return (
    stage !== "failed" &&
    (stage !== "draft" || (!raises && isIdea(launch.record))) &&
    listedHere(launch.record, raises)
  );
}

/**
 * The requests for help the rail may show, from the same projects Discover lists (any of them, not only the few the
 * rail shows by name): each project's newest, newest first. Which are still open is read after (`useStillOpen`), and
 * the first few of those are shown. A short list, not a ranking.
 */
export function railHelpCandidates(
  launches: readonly Launch[],
  raises: boolean,
  limit: number = RAIL_LIMITS.helpCandidates,
): OpenHelpRequest[] {
  return helpCandidates(
    launches.filter((launch) => listed(launch, raises)),
    limit,
  );
}

/**
 * One readable line of a post for the rail: its first line of words, with links and mention keys left out, cut at a
 * word boundary. Empty when the post has no words (only a link or a picture).
 */
export function railBlurb(content: string, max = 110): string {
  const words = content
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\b(?:https?:\/\/|nostr:)\S+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((line) => line !== "");
  if (!words || words.length <= max) return words ?? "";
  const cut = words.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The trending post ids the rail reads: the top few, never the whole trending list. */
export function railPostIds(ids: readonly string[] | undefined): string[] {
  return (ids ?? []).slice(0, RAIL_LIMITS.postsRead);
}

/**
 * The trending posts the rail shows: those not written by someone the reader muted, in the order read, up to the limit.
 * `muted` holds lower-case public keys (the mute list's own form).
 */
export function railPosts<Row extends { event: { pubkey: string } }>(
  rows: readonly Row[],
  muted: ReadonlySet<string>,
  limit: number = RAIL_LIMITS.posts,
): Row[] {
  return rows
    .filter((row) => !muted.has(row.event.pubkey.toLowerCase()))
    .slice(0, limit);
}
