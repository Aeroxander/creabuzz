/**
 * "Just started": the listed projects that began less than a week ago and have no update yet, for a strip on Home. It
 * gives a quiet server something true to show on its first day: who has begun, and a way to follow them.
 *
 * Only what the signed records say: a project's own start date and the updates its own team signed (anyone else's
 * records about it do not count). Never a price. Not the reader's own project (they were told when they started it),
 * not a project its founder chose not to list, and not one the feed already announces with its own "Just started"
 * card, so the same project is never said twice.
 *
 * Pure and alias-free: `just-started.test.mjs` drives it under `node --test`.
 */

const DAY = 86_400;
/** A project is "just started" for this many days, or until its first update. */
const JUST_STARTED_DAYS = 7;
/** How many the strip shows. */
export const JUST_STARTED_SHOWN = 6;
/** The server takes no record dated more than this far ahead; a start dated slightly ahead is today's. */
const AHEAD = 900;

interface StartedLaunch {
  record: {
    id: string;
    author: string;
    eventId: string;
    startedAt: number;
    listing?: "unlisted" | null;
    team: ReadonlyArray<{ pubkey: string }>;
  };
  updates: ReadonlyArray<{ author: string }>;
}

/** Newest first, at most {@link JUST_STARTED_SHOWN}. `announced` holds the coordinates the feed already announces. */
export function justStarted<T extends StartedLaunch>(
  launches: readonly T[],
  input: {
    now: number;
    me: string | null;
    announced: ReadonlySet<string>;
    coordinate: (record: T["record"]) => string;
  },
): T[] {
  return launches
    .filter((launch) => {
      const { record } = launch;
      if (record.listing === "unlisted") return false;
      if (input.me !== null && record.author === input.me) return false;
      if (input.announced.has(input.coordinate(record))) return false;
      const age = input.now - record.startedAt;
      if (age < -AHEAD || age >= JUST_STARTED_DAYS * DAY) return false;
      const team = new Set([
        record.author,
        ...record.team.map((member) => member.pubkey),
      ]);
      return !launch.updates.some((update) => team.has(update.author));
    })
    .sort(
      (a, b) =>
        b.record.startedAt - a.record.startedAt ||
        (a.record.eventId < b.record.eventId ? -1 : 1),
    )
    .slice(0, JUST_STARTED_SHOWN);
}
