import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import {
  KIND_CONTACT_LIST,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { SEEN_EVENT } from "@/shared/lib/seen-state";

import { indexProfiles } from "../profiles/lib/index-profiles";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
} from "../board/lib/board-events";
import {
  buildModerationNotifications,
  KIND_BOARD_MODERATION_LOG,
  MODERATION_NOTICE_LIMIT,
} from "./lib/moderation-notices";
import { badgeState } from "./lib/notifications-state";
import {
  buildBoardNotifications,
  buildNotifications,
  type NotificationItem,
  readSeenAt,
  withoutMuted,
  writeSeenAt,
} from "./lib/notifications";
import { buildRows, sortNewestFirst, type SignedEvent } from "./lib/timeline";
import {
  mostFollowed,
  scoreNotes,
  topIds,
  trendingHashtags,
} from "./lib/trending";
import { usePriorityNotifications } from "./use-launch-updates";
import { useHelpNotices } from "../launchpad/use-help-requests";
import { useTaskNotices } from "../launchpad/use-tasks";
import { readEvents } from "./read";
import { readUnknown } from "./lib/read-view";
import { useMutedPeople, useMutedSet } from "./use-social-actions";
import { socialKeys, useFollowing } from "./use-social-data";

/** How far back trending looks: communities are small, so three days. */
const TRENDING_WINDOW_SECONDS = 3 * 24 * 60 * 60;
const SEARCH_SCAN_LIMIT = 1000;

/** How many of your newest board posts and replies are watched for replies and up votes. */
const BOARD_WATCH_LIMIT = 200;

/**
 * Board replies and up votes on your own board posts and replies. Board records name what they answer, not who wrote
 * it, so this reads your newest posts and replies and then what names them.
 */
async function fetchBoardNotifications(me: string) {
  const mine = await readEvents({
    kinds: [KIND_FORUM_POST, KIND_FORUM_COMMENT],
    authors: [me],
    limit: BOARD_WATCH_LIMIT,
  });
  if (mine.length === 0) return [];
  const related = await readEvents({
    kinds: [KIND_FORUM_COMMENT, KIND_FORUM_VOTE],
    "#e": mine.map((e) => e.id),
    limit: 1000,
  });
  return buildBoardNotifications(mine, related, me);
}

/**
 * Up votes, reposts, quotes, replies, mentions, new followers, board replies and up votes, and a moderator's notices
 * about you (a removed post or reply, a board mute), aimed at you. A mute hides what a muted person did, never a
 * moderator's notice. Any read failing fails the whole read, so a partial list is never shown as complete; a failed
 * refresh keeps the last good list.
 */
export function useNotifications() {
  const me = existingUserPubkey();
  const muted = useMutedSet();
  const hideMuted = useCallback(
    (items: NotificationItem[]) => withoutMuted(items, muted),
    [muted],
  );
  return useQuery({
    queryKey: [...socialKeys.all, "notifications", me],
    select: hideMuted,
    enabled: Boolean(me),
    staleTime: 30_000,
    // The relay does not fan out `#p` filters, so polling is how they arrive.
    refetchInterval: 30_000,
    queryFn: async () => {
      const [social, board, moderation] = await Promise.all([
        readEvents({
          kinds: [
            KIND_TEXT_NOTE,
            KIND_REPOST,
            KIND_REACTION,
            KIND_CONTACT_LIST,
          ],
          "#p": [me as string],
          limit: 500,
        }),
        fetchBoardNotifications(me as string),
        // A board's log entries about you, which the server writes and names you in.
        readEvents({
          kinds: [KIND_BOARD_MODERATION_LOG],
          "#p": [me as string],
          limit: MODERATION_NOTICE_LIMIT,
        }),
      ]);
      return [
        ...buildNotifications(social, me as string),
        ...board,
        ...buildModerationNotifications(moderation, me as string),
      ].sort((a, b) => b.at - a.at);
    },
  });
}

/**
 * The unread count for the nav, plus `markSeen` (kept in this browser). `failed` is set when the read failed and there
 * is nothing to count, so the nav can say so instead of showing nothing new.
 */
export function useNotificationBadge() {
  const me = existingUserPubkey();
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const items = notifications.data;
  const updates = usePriorityNotifications();
  // Offers to help on your projects, and replies to offers you made: counted with the rest, hidden by a mute.
  const muted = useMutedSet();
  const help = useHelpNotices(muted);
  // Task steps that need you or answer you: counted the same way.
  const tasks = useTaskNotices(muted).notices;
  const seenKey = [...socialKeys.all, "notifications-seen", me];
  const seen = useQuery({
    queryKey: seenKey,
    enabled: Boolean(me),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => (me ? readSeenAt(relayWsUrl(), me) : 0),
  }).data;
  // Marked read from the rooms' side of the same bell (or in another tab): this count follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is made of `me`
  useEffect(() => {
    if (!me) return;
    const sync = () =>
      queryClient.setQueryData(seenKey, readSeenAt(relayWsUrl(), me));
    window.addEventListener(SEEN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SEEN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [me, queryClient]);
  const mark = useMutation({
    mutationFn: async () => {
      if (!me) return;
      const newest =
        Math.max(
          items?.[0]?.at ?? 0,
          updates[0]?.at ?? 0,
          help[0]?.at ?? 0,
          tasks[0]?.at ?? 0,
        ) || Math.floor(Date.now() / 1000);
      writeSeenAt(relayWsUrl(), me, newest);
      queryClient.setQueryData(seenKey, readSeenAt(relayWsUrl(), me));
      window.dispatchEvent(new Event(SEEN_EVENT));
    },
  });
  const { unread, failed } = badgeState(
    items,
    notifications.error,
    [...updates, ...help, ...tasks],
    seen,
  );
  return {
    seenAt: seen ?? 0,
    unread,
    failed,
    markSeen: mark.mutate,
  };
}

/** Recently engaged-with notes and the hashtags in use. */
export function useTrending() {
  return useQuery({
    queryKey: [...socialKeys.all, "trending"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const since = Math.floor(Date.now() / 1000) - TRENDING_WINDOW_SECONDS;
      const [reactions, reposts, notes] = await Promise.all([
        readEvents({ kinds: [KIND_REACTION], since, limit: 1000 }),
        readEvents({ kinds: [KIND_REPOST], since, limit: 1000 }),
        readEvents({ kinds: [KIND_TEXT_NOTE], since, limit: 1000 }),
      ]);
      return {
        ids: topIds(scoreNotes([...reactions, ...reposts, ...notes]), 30),
        hashtags: trendingHashtags(notes, 10),
      };
    },
  });
}

/**
 * Accounts many others follow that you don't yet, never someone you muted. Waits for the mute list to be read, so a
 * muted person is never suggested and then taken away. If that read failed and the list is unknown, nobody is
 * suggested: the caller shows the failure (`readUnknown`) and retries the mute list, which starts this read.
 */
export function useSuggestedUsers(limit = 5) {
  const me = existingUserPubkey();
  const following = useFollowing(me).data;
  const mutedRead = useMutedPeople();
  const muted = mutedRead.data;
  const mutesUnknown = readUnknown(mutedRead);
  return useQuery({
    queryKey: [
      ...socialKeys.all,
      "suggested",
      me,
      following?.length ?? -1,
      // Who is muted, not how many: muting one person and unmuting another must not reuse the old list.
      // An unknown list has a key of its own, so it never reuses suggestions made with a known one.
      mutesUnknown ? "unknown" : muted ? [...muted].sort().join(",") : "",
      limit,
    ],
    enabled:
      (me === null || following !== undefined) &&
      !mutedRead.isLoading &&
      !mutesUnknown,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const lists = await readEvents({
        kinds: [KIND_CONTACT_LIST],
        limit: 1000,
      });
      return mostFollowed(
        lists,
        new Set([...(following ?? []), ...(me ? [me] : []), ...(muted ?? [])]),
        limit,
      );
    },
  });
}

/** People search: NIP-50 over profiles (the relay indexes kind 0 for search). */
export function useUserSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: [...socialKeys.all, "search-people", q],
    enabled: q.length > 0 && !q.startsWith("#"),
    staleTime: 30_000,
    queryFn: async () => {
      const events = await readEvents({
        kinds: [KIND_PROFILE],
        search: q,
        limit: 30,
      });
      return indexProfiles(events);
    },
  });
}

/**
 * Post search over the latest notes, filtered in the browser: the relay's
 * full-text index does not cover plain notes, so this only sees recent posts.
 */
export function usePostSearch(query: string) {
  const q = query.trim().toLowerCase();
  return useQuery({
    queryKey: [...socialKeys.all, "search-posts", q],
    enabled: q.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const events = (await readEvents({
        kinds: [KIND_TEXT_NOTE],
        limit: SEARCH_SCAN_LIMIT,
      })) as SignedEvent[];
      return buildRows(
        sortNewestFirst(events)
          .filter((e) => e.content.toLowerCase().includes(q))
          .slice(0, 50),
      );
    },
  });
}
