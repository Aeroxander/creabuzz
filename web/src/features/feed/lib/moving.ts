/**
 * "Moving now": the projects with the most real activity lately, for Home's strip and the Projects page.
 *
 * A project's score is the number of the last seven days on which its founder or team signed an update. It is
 * deliberately not a count of records (ten updates in an afternoon are one day), not when the project's record was
 * last saved (saving again moves nothing), and never a price. A record dated ahead of now is not counted. Only
 * updates signed by the project's own people count; anyone else's records about it do not.
 *
 * What a founder can still do is post a little every day, which is the behaviour the score is for. Dating a record
 * back to fill an empty day is the one thing the dates alone cannot rule out: the server takes no record dated more
 * than a quarter of an hour ahead, but does take older dates, so a day here is "a day the team says it posted on".
 *
 * Pure and alias-free: `moving.test.mjs` drives it under `node --test`.
 */

const DAY = 86_400;
/** The window the score looks at. */
const MOVING_DAYS = 7;

interface MovingLaunch {
  record: {
    id: string;
    author: string;
    eventId: string;
    startedAt: number;
    team: ReadonlyArray<{ pubkey: string }>;
  };
  updates: ReadonlyArray<{ author: string; createdAt: number }>;
}

export interface Moving<T> {
  launch: T;
  /** On how many of the last seven days the team posted. */
  days: number;
  /** When the team last posted. */
  lastAt: number;
}

/** On how many of the last seven days (ending now) the project's own people signed an update, and the latest. */
export function activeDays(
  launch: MovingLaunch,
  now: number,
): { days: number; lastAt: number } {
  const team = new Set([
    launch.record.author,
    ...launch.record.team.map((m) => m.pubkey),
  ]);
  const days = new Set<number>();
  let lastAt = 0;
  for (const update of launch.updates) {
    if (!team.has(update.author)) continue;
    if (update.createdAt > now || update.createdAt <= now - MOVING_DAYS * DAY)
      continue;
    days.add(Math.floor((now - update.createdAt) / DAY));
    lastAt = Math.max(lastAt, update.createdAt);
  }
  return { days: days.size, lastAt };
}

/**
 * The projects that posted on at least one of the last seven days, the most active first; then whoever posted most
 * recently; then by id, so the order never flickers.
 */
export function movingNow<T extends MovingLaunch>(
  launches: readonly T[],
  now: number,
  limit = 12,
): Moving<T>[] {
  return launches
    .map((launch) => ({ launch, ...activeDays(launch, now) }))
    .filter((entry) => entry.days > 0)
    .sort(
      (a, b) =>
        b.days - a.days ||
        b.lastAt - a.lastAt ||
        (a.launch.record.eventId < b.launch.record.eventId ? -1 : 1),
    )
    .slice(0, limit);
}

/** "Posted on 5 of the last 7 days", "Posted today" for a single day that is today. */
export function movingLine(
  entry: { days: number; lastAt: number },
  now: number,
) {
  if (entry.days === 1)
    return now - entry.lastAt < DAY ? "Posted today" : "Posted this week";
  return `Posted on ${entry.days} of the last ${MOVING_DAYS} days`;
}
