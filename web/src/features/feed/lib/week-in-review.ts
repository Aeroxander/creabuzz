/**
 * "This week on Creaton": what the signed records say happened in the last seven days, as plain counts worked out in
 * the browser: updates posted, promises answered kept and missed, pieces of work accepted, and projects started.
 *
 * Only the same signed records the feed shows: updates from the people who speak for a project, answers the founder
 * signed, work its team accepted, and the project records themselves. Nothing is invented, ranked or priced.
 *
 * It is shown from the server's second week and never as an empty week: until then, and when nothing happened, there is
 * no card at all. A count that comes from a read that did not reach back a whole week is said to be "at least".
 *
 * Pure and alias-free: `week-in-review.test.mjs` drives it under `node --test`.
 */

import type { FeedItem } from "./record-feed.ts";

const DAY = 86_400;
const WEEK = 7 * DAY;

export interface WeekCounts {
  updates: number;
  kept: number;
  missed: number;
  work: number;
  started: number;
}

/**
 * The week's counts, or null when there is nothing to say: the server is still in its first week, or no record was
 * signed this week. `starts` are the listed projects' start times; `partial` says the feed's read stopped before it
 * reached back a whole week.
 */
export function weekInReview(input: {
  items: readonly FeedItem[];
  starts: readonly number[];
  now: number;
}): WeekCounts | null {
  const { now } = input;
  const earliest = input.starts.length > 0 ? Math.min(...input.starts) : null;
  // From week two only: a server's first week has too little in it to count.
  if (earliest === null || now - earliest < WEEK) return null;
  const since = now - WEEK;
  const counts: WeekCounts = {
    updates: 0,
    kept: 0,
    missed: 0,
    work: 0,
    started: input.starts.filter((at) => at > since && at <= now).length,
  };
  for (const item of input.items) {
    if (item.at <= since || item.at > now) continue;
    if (item.kind === "update") {
      counts.updates += 1;
      counts.kept += item.answers.kept;
      counts.missed += item.answers.missed;
    } else if (item.kind === "work") {
      counts.work += 1;
    }
  }
  const total =
    counts.updates + counts.kept + counts.missed + counts.work + counts.started;
  return total === 0 ? null : counts;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The week as short lines, leaving out whatever is zero. `atLeast` says the counts may be short. */
export function weekInReviewLines(
  counts: WeekCounts,
  atLeast: boolean,
): string[] {
  const more = atLeast ? "at least " : "";
  const lines = [
    counts.updates > 0
      ? `${more}${plural(counts.updates, "update posted", "updates posted")}`
      : null,
    counts.kept > 0
      ? `${more}${plural(counts.kept, "promise kept", "promises kept")}`
      : null,
    counts.missed > 0
      ? `${more}${plural(counts.missed, "promise missed", "promises missed")}`
      : null,
    counts.work > 0
      ? `${more}${plural(counts.work, "piece of work accepted", "pieces of work accepted")}`
      : null,
    counts.started > 0
      ? `${plural(counts.started, "new project", "new projects")}`
      : null,
  ];
  return lines.filter((line): line is string => line !== null);
}
