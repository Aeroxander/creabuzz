/**
 * Launch updates as the app sees them: the team's marked posts, which of them
 * are priority, which the viewer should be told about, and the viewer's own
 * per-launch opt-outs (kept in this browser).
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";

import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";

import { followedLaunches } from "../feed/lib/lists";
import { useMyLists } from "../feed/use-feed";
import { useLaunches } from "../launchpad/use-launches";
import {
  LAUNCH_UPDATE_LABEL,
  type LaunchUpdate,
  priorityIds,
  teamsFromLaunches,
  verifiedUpdates,
} from "./lib/launch-update";
import { readEvents } from "./read";
import { socialKeys } from "./use-social-data";

const MUTED_KEY = "creaton.launch-updates.muted";

function readMuted(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MUTED_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

// One shared store, so turning a launch off in one place is seen everywhere
// at once (the notification list, the badge, the section that holds the button).
let mutedSnapshot: Set<string> | null = null;
const mutedListeners = new Set<() => void>();
const getMuted = () => {
  mutedSnapshot ??= readMuted();
  return mutedSnapshot;
};
const subscribeMuted = (listener: () => void) => {
  mutedListeners.add(listener);
  return () => mutedListeners.delete(listener);
};
function toggleMuted(coord: string) {
  const next = new Set(getMuted());
  if (!next.delete(coord)) next.add(coord);
  mutedSnapshot = next;
  try {
    localStorage.setItem(MUTED_KEY, JSON.stringify([...next]));
  } catch {
    // Not remembered; it resets on reload.
  }
  for (const listener of mutedListeners) listener();
}

/** Launches whose priority updates the viewer turned off, and the switch. */
export function useMutedLaunchUpdates() {
  const muted = useSyncExternalStore(subscribeMuted, getMuted);
  return { muted, toggle: toggleMuted };
}

/** Every verified launch update on this relay, newest first. */
export function useLaunchUpdates() {
  const launches = useLaunches();
  const events = useQuery({
    queryKey: [...socialKeys.all, "launch-updates"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: () =>
      readEvents({
        kinds: [KIND_TEXT_NOTE],
        "#l": [LAUNCH_UPDATE_LABEL],
        limit: 300,
      }),
  });
  return useMemo(() => {
    const teams = teamsFromLaunches(
      (launches.data ?? []).map((l) => ({
        author: l.record.author,
        id: l.record.id,
        team: l.record.team,
      })),
    );
    const updates = verifiedUpdates(events.data ?? [], teams);
    const priority = priorityIds(updates);
    return {
      teams,
      updates,
      priority,
      ids: new Set(updates.map((u) => u.id)),
      isLoading: events.isLoading || launches.isLoading,
    };
  }, [events.data, events.isLoading, launches.data, launches.isLoading]);
}

/** Priority updates for launches the viewer follows, not their own, not muted. */
export function usePriorityNotifications(): LaunchUpdate[] {
  const me = existingUserPubkey();
  const { updates, priority } = useLaunchUpdates();
  const lists = useMyLists();
  const { muted } = useMutedLaunchUpdates();
  return useMemo(() => {
    if (!me) return [];
    const followed = followedLaunches(lists.data?.bookmarks ?? null);
    return updates.filter(
      (u) =>
        priority.has(u.id) &&
        u.author !== me &&
        followed.has(u.coord) &&
        !muted.has(u.coord),
    );
  }, [me, updates, priority, lists.data, muted]);
}

/** Launches the viewer may post updates for (they are on the team). */
export function useMyTeamLaunches() {
  const me = existingUserPubkey();
  const launches = useLaunches();
  return useMemo(
    () =>
      me
        ? (launches.data ?? [])
            .map((l) => l.record)
            .filter(
              (r) => r.author === me || r.team.some((t) => t.pubkey === me),
            )
        : [],
    [me, launches.data],
  );
}
