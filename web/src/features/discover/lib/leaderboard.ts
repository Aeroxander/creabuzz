/**
 * The Projects page as a scoreboard: for each listed project, how many weeks in a row it has posted, how many of
 * its answered promises it kept, how many requests for help are open, and how active it was this week. The score is
 * promises kept and work in the open, never a price.
 *
 * What counts, and what cannot earn a point:
 * - only records signed by the project's own people (the founder, and the team on the founder's record) count; the
 *   promises and their answers are the founder's alone;
 * - a record dated ahead of now is not counted (the server takes none dated more than a quarter of an hour ahead,
 *   and this ignores even that quarter of an hour);
 * - a record dated before the project was first published is not counted: a streak cannot start before the project;
 * - a week counts once however many updates it holds, and a streak is weeks in a row ending this week or last.
 *
 * What the dates alone cannot rule out is a record dated back into an empty week after the fact: the server does not
 * say when it received a record. Until it does, a streak is "weeks the team says it posted in", bounded as above.
 *
 * Pure and alias-free: `leaderboard.test.mjs` drives it under `node --test`.
 */

import {
  promiseRecord,
  promiseTotals,
  type RecordUpdate,
} from "../../launchpad/lib/promises.ts";
import { weeksInARow } from "../../launchpad/lib/weekly-update.ts";

const DAY = 86_400;

export interface BoardUpdate extends RecordUpdate {
  /** The update asks for help. */
  asks?: boolean;
}

export interface BoardProject {
  coordinate: string;
  founder: string;
  /** The founder and everyone on the founder's record. */
  team: ReadonlySet<string>;
  /** When the project was first published. */
  startedAt: number;
}

export interface ProjectScore {
  coordinate: string;
  /** Weeks in a row with an update, ending this week or last. */
  streak: number;
  /** Promises the founder marked kept, and how many they answered at all (kept, missed or changed). */
  kept: number;
  answered: number;
  /** Requests for help nobody on the team has marked as found. */
  openHelp: number;
  /** When the newest open request was made, for ordering "Looking for help". */
  askedAt: number;
  /** On how many of the last seven days the team posted. */
  days: number;
  startedAt: number;
}

/** One project's score from its team's updates and the ids of the requests its team marked as found. */
export function projectScore(
  project: BoardProject,
  updates: readonly BoardUpdate[],
  found: ReadonlySet<string>,
  now: number,
): ProjectScore {
  const counted = updates.filter(
    (u) =>
      project.team.has(u.author) &&
      u.createdAt <= now &&
      u.createdAt >= project.startedAt,
  );
  const weekly = counted.filter((u) => u.weekly);
  const totals = promiseTotals(
    promiseRecord(
      counted.filter((u) => u.author === project.founder),
      project.founder,
    ),
  );
  const asking = counted.filter((u) => u.asks && !found.has(u.id));
  const days = new Set(
    counted
      .filter((u) => u.createdAt > now - 7 * DAY)
      .map((u) => Math.floor((now - u.createdAt) / DAY)),
  );
  return {
    coordinate: project.coordinate,
    streak: weeksInARow(
      weekly.map((u) => u.createdAt),
      now,
    ),
    kept: totals.kept,
    answered: totals.kept + totals.missed + totals.changed,
    openHelp: asking.length,
    askedAt: Math.max(0, ...asking.map((u) => u.createdAt)),
    days: days.size,
    startedAt: project.startedAt,
  };
}

export type BoardTab = "moving" | "new" | "kept" | "help";

export const BOARD_TABS: readonly { id: BoardTab; label: string }[] = [
  { id: "moving", label: "Moving now" },
  { id: "new", label: "New" },
  { id: "kept", label: "Most kept promises" },
  { id: "help", label: "Looking for help" },
];

/**
 * The projects a tab lists, in its order. Ties always end on the coordinate, so the order never flickers.
 * - Moving now: posted this week, most days first, then the longer streak.
 * - New: first published most recently (saving a record again moves nothing).
 * - Most kept promises: at least one kept, most kept first, then the fewer misses.
 * - Looking for help: an open request, the newest request first.
 */
export function boardOrder(
  scores: readonly ProjectScore[],
  tab: BoardTab,
): ProjectScore[] {
  const tie = (a: ProjectScore, b: ProjectScore) =>
    a.coordinate < b.coordinate ? -1 : a.coordinate > b.coordinate ? 1 : 0;
  switch (tab) {
    case "moving":
      return scores
        .filter((s) => s.days > 0)
        .sort((a, b) => b.days - a.days || b.streak - a.streak || tie(a, b));
    case "new":
      return [...scores].sort((a, b) => b.startedAt - a.startedAt || tie(a, b));
    case "kept":
      return scores
        .filter((s) => s.kept > 0)
        .sort(
          (a, b) =>
            b.kept - a.kept ||
            a.answered - a.kept - (b.answered - b.kept) ||
            tie(a, b),
        );
    case "help":
      return scores
        .filter((s) => s.openHelp > 0)
        .sort((a, b) => b.askedAt - a.askedAt || tie(a, b));
  }
}

/** "6 weeks in a row", "1 week", or null with no streak. */
export function streakWords(streak: number): string | null {
  if (streak <= 0) return null;
  return streak === 1 ? "Posted this week" : `${streak} weeks in a row`;
}

/** "9 of 11 promises kept", or null when none was answered yet. */
export function keptWords(score: Pick<ProjectScore, "kept" | "answered">) {
  if (score.answered === 0) return null;
  return `${score.kept} of ${score.answered} ${score.answered === 1 ? "promise" : "promises"} kept`;
}
