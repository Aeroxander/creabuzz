import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";

import {
  coordinatesFromLegacyKeys,
  followedLaunches,
  withLaunch,
  withMigratedLaunches,
} from "./lib/lists";
import { useMyLists, usePublishFeedEvent } from "./use-feed";

/** Where launch follows lived before they were published (browser only). */
const LEGACY_KEY = "buzz.launchpad.followed";

function readLegacy(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? coordinatesFromLegacyKeys(
          parsed.filter((v): v is string => typeof v === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function clearLegacy(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_KEY);
  } catch {
    // Nothing readable either; the next load simply finds nothing to migrate.
  }
}

/**
 * The launches this person follows, from their published bookmark list, with
 * a one-time move of the old browser-only list into it. The old list is only
 * removed after the relay accepted the migrated bookmarks (Review-Proven
 * Rule 1: never drop the only copy before its replacement is durable).
 */
export function useLaunchFollows() {
  const me = existingUserPubkey();
  const lists = useMyLists();
  const publish = usePublishFeedEvent();
  // One attempt per visit: a failure keeps the old list (still shown below)
  // and is retried on the next page load, never in a render loop.
  const attempted = useRef(false);
  const { mutate } = publish;

  useEffect(() => {
    if (!me || !lists.isSuccess || attempted.current) return;
    const legacy = readLegacy();
    if (legacy.length === 0) return;
    attempted.current = true;
    const template = withMigratedLaunches(lists.data.bookmarks, legacy);
    if (!template) {
      clearLegacy();
      return;
    }
    mutate(template, { onSuccess: clearLegacy });
  }, [me, lists.isSuccess, lists.data, mutate]);

  const followed = useMemo(() => {
    const set = followedLaunches(lists.data?.bookmarks ?? null);
    for (const coord of readLegacy()) set.add(coord);
    return set;
  }, [lists.data]);

  /** `onDone` runs once the follow list change is accepted by the server. */
  const toggle = (coord: string, onDone?: () => void) => {
    if (!me) {
      toast.error("Create your identity from the profile menu to follow.");
      return;
    }
    if (!lists.isSuccess) return;
    publish.mutate(
      withLaunch(lists.data.bookmarks, coord, !followed.has(coord)),
      {
        onSuccess: onDone,
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not update follows.",
          ),
      },
    );
  };

  return {
    followed,
    toggle,
    ready: !me || lists.isSuccess,
    pending: publish.isPending,
  };
}
