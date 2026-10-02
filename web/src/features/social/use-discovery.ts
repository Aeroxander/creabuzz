import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  KIND_CONTACT_LIST,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";

import { indexProfiles } from "../profiles/lib/index-profiles";
import {
  buildNotifications,
  readSeenAt,
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
import { readEvents } from "./read";
import { socialKeys, useFollowing } from "./use-social-data";

/** How far back trending looks: communities are small, so three days. */
const TRENDING_WINDOW_SECONDS = 3 * 24 * 60 * 60;
const SEARCH_SCAN_LIMIT = 1000;

/** Likes, reposts, quotes, replies, mentions and new followers aimed at you. */
export function useNotifications() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: [...socialKeys.all, "notifications", me],
    enabled: Boolean(me),
    staleTime: 30_000,
    // The relay does not fan out `#p` filters, so polling is how they arrive.
    refetchInterval: 30_000,
    queryFn: async () =>
      buildNotifications(
        await readEvents({
          kinds: [
            KIND_TEXT_NOTE,
            KIND_REPOST,
            KIND_REACTION,
            KIND_CONTACT_LIST,
          ],
          "#p": [me as string],
          limit: 500,
        }),
        me as string,
      ),
  });
}

/** The unread count for the nav, plus `markSeen` (kept in this browser). */
export function useNotificationBadge() {
  const me = existingUserPubkey();
  const queryClient = useQueryClient();
  const items = useNotifications().data;
  const updates = usePriorityNotifications();
  const seenKey = [...socialKeys.all, "notifications-seen", me];
  const seen = useQuery({
    queryKey: seenKey,
    enabled: Boolean(me),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => (me ? readSeenAt(me) : 0),
  }).data;
  const mark = useMutation({
    mutationFn: async () => {
      if (!me) return;
      const newest =
        Math.max(items?.[0]?.at ?? 0, updates[0]?.at ?? 0) ||
        Math.floor(Date.now() / 1000);
      writeSeenAt(me, newest);
      queryClient.setQueryData(seenKey, newest);
    },
  });
  return {
    seenAt: seen ?? 0,
    unread:
      seen === undefined
        ? 0
        : (items ?? []).filter((n) => n.at > seen).length +
          updates.filter((u) => u.at > seen).length,
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

/** Accounts many others follow that you don't yet. */
export function useSuggestedUsers(limit = 5) {
  const me = existingUserPubkey();
  const following = useFollowing(me).data;
  return useQuery({
    queryKey: [
      ...socialKeys.all,
      "suggested",
      me,
      following?.length ?? -1,
      limit,
    ],
    enabled: me === null || following !== undefined,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const lists = await readEvents({
        kinds: [KIND_CONTACT_LIST],
        limit: 1000,
      });
      return mostFollowed(
        lists,
        new Set([...(following ?? []), ...(me ? [me] : [])]),
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
