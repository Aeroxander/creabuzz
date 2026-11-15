/**
 * Home's "Update day" rail: of the listed projects, how many have posted their weekly update since their update day
 * came round, and how many are due. "Due" is the app's own rule (`dueOnDay` in `launchpad/lib/update-day.ts`): the day
 * has come round since the last update, and it stays due until one is posted. It is a count, never a ranking or a
 * name, and the words stay neutral: an update is due, never late or missed.
 *
 * A project that began less than a week ago and has no update is neither: its first update is not due yet (those
 * projects are on Home's "Just started" strip). Only updates the project's own team signed count.
 *
 * Pure and alias-free: `update-day-tally.test.mjs` drives it under `node --test`.
 */

import { dueOnDay } from "../../launchpad/lib/update-day.ts";

const DAY = 86_400;
/** A first update falls due a week after the start. */
const FIRST_UPDATE_DAYS = 7;

interface TallyLaunch {
  record: {
    author: string;
    startedAt: number;
    listing?: "unlisted" | null;
    team: ReadonlyArray<{ pubkey: string }>;
  };
  updates: ReadonlyArray<{ author: string; createdAt: number }>;
}

export interface UpdateDayTally<T> {
  posted: T[];
  due: T[];
}

/**
 * `weekdayOf` says each project's update day (0 is Sunday): the weekday it started on unless its founder chose
 * another, which only the founder's own browser knows.
 */
export function updateDayTally<T extends TallyLaunch>(
  launches: readonly T[],
  now: number,
  weekdayOf: (launch: T) => number,
): UpdateDayTally<T> {
  const out: UpdateDayTally<T> = { posted: [], due: [] };
  for (const launch of launches) {
    const { record } = launch;
    if (record.listing === "unlisted") continue;
    const team = new Set([
      record.author,
      ...record.team.map((member) => member.pubkey),
    ]);
    let lastAt: number | null = null;
    for (const update of launch.updates)
      if (team.has(update.author) && update.createdAt <= now)
        lastAt = Math.max(lastAt ?? 0, update.createdAt);
    if (lastAt === null && now - record.startedAt < FIRST_UPDATE_DAYS * DAY)
      continue;
    (dueOnDay(weekdayOf(launch), lastAt, now) ? out.due : out.posted).push(
      launch,
    );
  }
  return out;
}

/** "4 projects have posted, 3 are due." Null when no project is in either count. */
export function updateDayWords(posted: number, due: number): string | null {
  if (posted === 0 && due === 0) return null;
  const has =
    posted === 0
      ? "No project has posted yet"
      : posted === 1
        ? "1 project has posted"
        : `${posted} projects have posted`;
  const dueWords =
    due === 0 ? "none are due" : due === 1 ? "1 is due" : `${due} are due`;
  return `${has}, ${dueWords}.`;
}
