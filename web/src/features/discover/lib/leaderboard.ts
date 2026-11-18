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
 * How the default order ("Most reliable") is made, and why money is not in it:
 * - weeks posted in a row come first, but a run counts for ranking only when it is paired with the record: at least
 *   {@link MIN_ANSWERED} promises answered, and no more missed (or left unanswered) than kept. A project that posts a
 *   line every week and answers nothing has a run to show and nothing to rank on;
 * - then promises kept, then fewer misses, then the newest real update (a weekly update that made or answered a
 *   promise, or says something in a sentence), so a short "done." every week does not move a project up;
 * - a project with no real update is not in that list at all; "New" and "Moving now" still show it.
 * No price, raise or amount is read anywhere here.
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

/** A run of weeks counts for ranking only with this many promises answered, the same rule the share picture uses. */
const MIN_ANSWERED = 2;

/** A weekly update with no promise and no answer is "real" when its one line says at least this much. */
const MIN_REAL_LINE = 24;

export interface BoardUpdate extends RecordUpdate {
  /** The update asks for help. */
  asks?: boolean;
  /** The stored "In one line" of a weekly update (`oneLineOf`), or "". */
  line?: string;
}

/**
 * Whether a weekly update says something: it made a promise, answered one, or its one line is a sentence's worth. A
 * bare "done." or an empty post is not, and so cannot place a project in the default order.
 */
export function isRealUpdate(update: BoardUpdate): boolean {
  if (!update.weekly) return false;
  return (
    (update.promises?.length ?? 0) > 0 ||
    (update.marks?.length ?? 0) > 0 ||
    (update.line ?? "").trim().length >= MIN_REAL_LINE
  );
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
  /** Promises answered "not done", and promises a later update left unanswered. Both count against a run. */
  missed: number;
  unanswered: number;
  /**
   * The streak as ranking counts it: the run of weeks only when it is paired with the record (at least
   * {@link MIN_ANSWERED} answered and no more missed or unanswered than kept), otherwise 0. Never shown.
   */
  rankStreak: number;
  /** When the newest real update ({@link isRealUpdate}) was posted, or 0 when there is none. */
  lastRealAt: number;
  /** The newest weekly update's stored one line, for the card; "" when there is none. */
  line: string;
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
  const streak = weeksInARow(
    weekly.map((u) => u.createdAt),
    now,
  );
  const paired =
    totals.kept + totals.missed + totals.changed >= MIN_ANSWERED &&
    totals.kept >= totals.missed + totals.unanswered;
  const real = counted.filter(isRealUpdate);
  const newestLine = weekly
    .filter((u) => (u.line ?? "").trim() !== "")
    .reduce<BoardUpdate | null>(
      (best, u) => (best === null || u.createdAt > best.createdAt ? u : best),
      null,
    );
  const asking = counted.filter((u) => u.asks && !found.has(u.id));
  const days = new Set(
    counted
      .filter((u) => u.createdAt > now - 7 * DAY)
      .map((u) => Math.floor((now - u.createdAt) / DAY)),
  );
  return {
    coordinate: project.coordinate,
    streak,
    kept: totals.kept,
    answered: totals.kept + totals.missed + totals.changed,
    missed: totals.missed,
    unanswered: totals.unanswered,
    rankStreak: paired ? streak : 0,
    lastRealAt: Math.max(0, ...real.map((u) => u.createdAt)),
    line: newestLine?.line?.trim() ?? "",
    openHelp: asking.length,
    askedAt: Math.max(0, ...asking.map((u) => u.createdAt)),
    days: days.size,
    startedAt: project.startedAt,
  };
}

export type BoardTab = "reliable" | "moving" | "new" | "kept" | "help";

/** The tabs in the order they show; the first is the one the page opens on. */
export const BOARD_TABS: readonly { id: BoardTab; label: string }[] = [
  { id: "reliable", label: "Most reliable" },
  { id: "moving", label: "Moving now" },
  { id: "new", label: "New" },
  { id: "kept", label: "Most kept promises" },
  { id: "help", label: "Looking for help" },
];

/**
 * The projects a tab lists, in its order. Ties always end on the coordinate, so the order never flickers.
 * - Most reliable: has a real update; longest run of weeks that is paired with the record, then most kept, then fewer
 *   misses, then the newest real update. Never a price or an amount.
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
    case "reliable":
      return scores
        .filter((s) => s.lastRealAt > 0)
        .sort(
          (a, b) =>
            b.rankStreak - a.rankStreak ||
            b.kept - a.kept ||
            a.missed + a.unanswered - (b.missed + b.unanswered) ||
            b.lastRealAt - a.lastRealAt ||
            tie(a, b),
        );
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
