/**
 * A founder's run of weekly updates and the one week it could break. A run counts calendar weeks (Monday to Sunday, in
 * UTC, `weeksInARow`), so it is safe for as long as the week is young. It is "at risk" only when all of this holds:
 * there is a run of two weeks or more, the update day has come round (the update is due), and nothing has been posted
 * yet this calendar week. The words say what posting does, never what not posting means.
 *
 * Pure and alias-free: `streak-risk.test.mjs` drives it under `node --test`.
 */

const DAY = 86_400;

/** The start of the calendar week `now` falls in: Monday 00:00 UTC, in seconds. */
export function weekStart(now: number): number {
  const day = Math.floor(now / DAY);
  // 1 January 1970 was a Thursday: three days on, the count turns over on Mondays.
  return (day - ((day + 3) % 7)) * DAY;
}

/** The run that an update this week would keep going, or null when nothing is at risk. */
export function streakAtRisk(input: {
  /** Weeks in a row, or null when it is not known. */
  streak: number | null;
  /** When the team last posted, or null for never. */
  lastUpdateAt: number | null;
  /** The update is due on the founder's update day (`dueOnDay`). */
  due: boolean;
  now: number;
}): number | null {
  const { streak, lastUpdateAt, due, now } = input;
  if (streak === null || streak < 2 || !due || lastUpdateAt === null)
    return null;
  return lastUpdateAt < weekStart(now) ? streak : null;
}

/** "An update this week keeps your run of 3 weeks going." Says what posting does, nothing about not posting. */
export function streakRiskWords(weeks: number): string {
  return `An update this week keeps your run of ${weeks} weeks going.`;
}
