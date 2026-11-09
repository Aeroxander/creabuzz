/**
 * What the right rail lists: a handful of projects, trending posts, hashtags and people, each with a "See all" link to
 * its full page. Pure, so `rail.test.mjs` drives it under `node --test` without a server.
 */

import { listedHere } from "../../launchpad/lib/contributor-only.ts";
import { isIdea } from "../../launchpad/lib/idea.ts";
import { effectiveStage, type Launch } from "../../launchpad/models.ts";

/** How many rows each rail block shows before its "See all". */
export const RAIL_LIMITS = {
  projects: 4,
  posts: 3,
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
    .filter((launch) => {
      const stage = effectiveStage(launch);
      return (
        stage !== "failed" &&
        (stage !== "draft" || (!raises && isIdea(launch.record))) &&
        listedHere(launch.record, raises)
      );
    })
    .sort(
      (a, b) =>
        b.record.createdAt - a.record.createdAt ||
        (a.record.id < b.record.id ? -1 : 1),
    )
    .slice(0, limit);
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
