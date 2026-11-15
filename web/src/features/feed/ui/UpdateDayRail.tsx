/**
 * Home's "Update day" rail: "4 projects have posted, 3 are due." A count, never a name or a rank, in neutral words: an
 * update is due, not missed. It reads the app's own rule for when a weekly update is due (`lib/update-day-tally.ts`),
 * so it never disagrees with a project's page.
 *
 * For someone who started a project that is due, it carries "Post your update" straight to that project's update. It
 * shows only when every project and update was read, so the counts are the whole server's; and nothing until a project
 * is due or has posted.
 */

import { Link } from "@tanstack/react-router";
import { CalendarCheck } from "lucide-react";
import { useMemo } from "react";

import {
  readUpdateDays,
  updateDayOf,
} from "@/features/launchpad/lib/update-day";
import { launchCoordinate } from "@/features/launchpad/models";
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
  const words = updateDayWords(tally.posted.length, tally.due.length);
  if (!words) return null;
  const mine = tally.due.filter(({ record }) => record.author === me);
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
      {mine.map(({ record }) => (
        <Link
          aria-label={
            mine.length > 1
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
          {mine.length > 1 ? `: ${record.name}` : ""}
        </Link>
      ))}
    </section>
  );
}
