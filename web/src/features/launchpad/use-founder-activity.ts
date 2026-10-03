import { useMemo, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

import {
  activityRows,
  parseSeenCounts,
  type SeenCounts,
} from "./lib/founder-activity";
import { launchCoordinate } from "./models";
import { useLaunches } from "./use-launches";
import { useSupporters } from "./use-supporters";

const SEEN_KEY = "creaton.supporters.seen";

function readSeen(): SeenCounts {
  try {
    return parseSeenCounts(globalThis.localStorage?.getItem(SEEN_KEY) ?? null);
  } catch {
    return {};
  }
}

/**
 * Remember the supporter count the founder has now seen. A per-browser
 * convenience: losing it only means the same supporters read as new again.
 */
export function markSupportersSeen(coord: string, count: number): void {
  try {
    const seen = readSeen();
    if (seen[coord] === count) return;
    globalThis.localStorage?.setItem(
      SEEN_KEY,
      JSON.stringify({ ...seen, [coord]: count }),
    );
  } catch {
    // Storage blocked: the founder just sees these supporters as new again.
  }
}

/** The founder's own launches, and which of them have new supporters. */
export function useFounderActivity() {
  const me = existingUserPubkey();
  const launches = useLaunches();
  const mine = useMemo(
    () =>
      (launches.data ?? [])
        .filter((launch) => me !== null && launch.record.author === me)
        .map((launch) => ({
          coord: launchCoordinate(launch.record.author, launch.record.id),
          id: launch.record.id,
          author: launch.record.author,
          name: launch.record.name,
        })),
    [launches.data, me],
  );
  const counts = useSupporters(mine.map((launch) => launch.coord));
  // Read once per mount: a visit to the notifications page is the "look".
  const [seen] = useState(readSeen);
  const rows = useMemo(
    () => activityRows(mine, counts.data ?? new Map(), seen),
    [mine, counts.data, seen],
  );
  return {
    rows,
    mine:
      launches.data?.filter((l) => me !== null && l.record.author === me) ?? [],
  };
}
