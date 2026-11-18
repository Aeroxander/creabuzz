/**
 * Home's "Update day" rail: "4 projects have posted, 3 are due." A count, never a name or a rank, in neutral words: an
 * update is due, not missed. It reads the app's own rule for when a weekly update is due (`lib/update-day-tally.ts`),
 * so it never disagrees with a project's page.
 *
 * For someone who started a project that is due, it carries "Post your update" straight to that project's update, unless
 * Home's next step already carries that same project's due update (one reminder per project, never two): that project is
 * left out of the count too, so the rail never says again what the next step just said. It shows only when every
 * project and update was read, so the counts are the whole server's; and nothing until a project is due or has posted.
 */

import { Link } from "@tanstack/react-router";
import { CalendarCheck } from "lucide-react";
import { useMemo } from "react";

import {
  readUpdateDays,
  updateDayOf,
} from "@/features/launchpad/lib/update-day";
import { launchCoordinate } from "@/features/launchpad/models";
import { useMyNeeds } from "@/features/launchpad/use-my-projects";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { updateDayTally, updateDayWords } from "../lib/update-day-tally";
import { progressScope } from "../use-progress-seen";
import { useListedLaunches } from "../use-listed-launches";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function UpdateDayRail() {
  const me = existingUserPubkey();
  const { listed, complete } = useListedLaunches();
  const mine = useMyNeeds();
  const tally = useMemo(() => {
    if (!listed || !complete) return null;
    const stored = readUpdateDays(storage());
    const relay = relayWsUrl();
    return updateDayTally(
      listed,
      Math.floor(Date.now() / 1000),
      ({ record }) =>
        // Someone's own chosen update day is known to their own browser only; every other project's is the weekday it
        // started on.
        updateDayOf(
          stored,
          progressScope(relay, me, launchCoordinate(record.author, record.id)),
          record.startedAt,
        ).weekday,
    );
  }, [listed, complete, me]);
  if (!tally) return null;
  // Home's next step already asks for a project's due update: the rail neither asks a second time nor counts that
  // project as due. While that is still being read the rail waits rather than show a line that then changes.
  const covered = new Set(
    mine.needs.flatMap(({ need }) =>
      need.kind === "update-due" ? [need.coordinate] : [],
    ),
  );
  const mayPost = mine.ready || mine.failed;
  if (me && !mayPost) return null;
  const words = updateDayWords(
    tally.posted.length,
    tally.due.filter(
      ({ record }) => !covered.has(launchCoordinate(record.author, record.id)),
    ).length,
  );
  if (!words) return null;
  const own = tally.due.filter(
    ({ record }) =>
      mayPost &&
      record.author === me &&
      !covered.has(launchCoordinate(record.author, record.id)),
  );
  return (
    <section
      aria-label="Update day"
      className="glass flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-3"
      data-testid="update-day-rail"
    >
      <CalendarCheck aria-hidden className="h-4 w-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-sm" data-testid="update-day-words">
        <span className="font-semibold">Update day.</span> {words}
      </p>
      {own.map(({ record }) => (
        <Link
          aria-label={
            own.length > 1
              ? `Post your update for ${record.name}`
              : "Post your update"
          }
          className="inline-flex shrink-0 items-center rounded-full bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground hover:bg-primary/90 max-sm:min-h-11 max-sm:px-4"
          data-testid="update-day-post"
          key={`${record.author}:${record.id}`}
          params={{ launchId: record.id }}
          search={{ action: "update", author: record.author }}
          to="/launchpad/$launchId"
        >
          Post your update
          {own.length > 1 ? `: ${record.name}` : ""}
        </Link>
      ))}
    </section>
  );
}
