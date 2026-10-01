import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  KIND_CONTACTS,
  KIND_NOTE,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_REPOST,
  parseProfile,
  sortNewestFirst,
  toPost,
} from "./feed-model";
import { buildNotifications, readSeenAt, writeSeenAt } from "./notifications";
import { mostFollowed, scoreNotes, topIds, trendingHashtags } from "./trending";
import { fetchEvents } from "./use-feed";
import { useContacts } from "./use-social";

const TRENDING_WINDOW_SECONDS = 3 * 24 * 60 * 60;
const SEARCH_SCAN_LIMIT = 1000;

/** Likes, reposts, replies, mentions and new followers aimed at the viewer. */
export function useNotifications(viewer: string | null) {
  return useQuery({
    queryKey: ["feed", "notifications", viewer],
    enabled: viewer !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!viewer) return [];
      const events = await fetchEvents({
        kinds: [KIND_NOTE, KIND_REPOST, KIND_REACTION, KIND_CONTACTS],
        "#p": [viewer],
        limit: 500,
      });
      return buildNotifications(events, viewer);
    },
  });
}

/** Unread count + a `markSeen` that persists the newest notification time. */
export function useNotificationBadge(viewer: string | null) {
  const queryClient = useQueryClient();
  const items = useNotifications(viewer).data;
  const seenKey = ["feed", "notifications-seen", viewer];
  const seen = useQuery({
    queryKey: seenKey,
    enabled: viewer !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => (viewer ? readSeenAt(viewer) : 0),
  }).data;
  const mark = useMutation({
    mutationFn: async () => {
      if (!viewer) return;
      const newest = items?.[0]?.at ?? Math.floor(Date.now() / 1000);
      writeSeenAt(viewer, newest);
      queryClient.setQueryData(seenKey, newest);
    },
  });
  return {
    seenAt: seen ?? 0,
    unread:
      seen === undefined ? 0 : (items ?? []).filter((n) => n.at > seen).length,
    markSeen: mark.mutate,
  };
}

/** Recently engaged-with notes (likes + 2×reposts + 2×replies) and top hashtags. */
export function useTrending() {
  return useQuery({
    queryKey: ["feed", "trending"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const since = Math.floor(Date.now() / 1000) - TRENDING_WINDOW_SECONDS;
      const [reactions, reposts, notes] = await Promise.all([
        fetchEvents({ kinds: [KIND_REACTION], since, limit: 1000 }),
        fetchEvents({ kinds: [KIND_REPOST], since, limit: 1000 }),
        fetchEvents({ kinds: [KIND_NOTE], since, limit: 1000 }),
      ]);
      const scores = scoreNotes([...reactions, ...reposts, ...notes]);
      return {
        ids: topIds(scores, 30),
        hashtags: trendingHashtags(notes, 10),
      };
    },
  });
}

/** Accounts many others follow that the viewer doesn't yet. */
export function useSuggestedUsers(viewer: string | null, limit = 5) {
  const follows = useContacts(viewer).data;
  return useQuery({
    queryKey: ["feed", "suggested", viewer, follows?.length ?? -1],
    enabled: viewer === null || follows !== undefined,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const lists = await fetchEvents({ kinds: [KIND_CONTACTS], limit: 1000 });
      const exclude = new Set([
        ...(follows ?? []),
        ...(viewer ? [viewer] : []),
      ]);
      return mostFollowed(lists, exclude, limit);
    },
  });
}

/** People search through NIP-50 on kind 0 (the relay's FTS indexes profiles). */
export function useUserSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["feed", "search-users", q],
    enabled: q.length > 0 && !q.startsWith("#"),
    staleTime: 30_000,
    queryFn: async () => {
      const events = await fetchEvents({
        kinds: [KIND_PROFILE],
        search: q,
        limit: 20,
      });
      const latest = new Map<string, (typeof events)[number]>();
      for (const e of events) {
        const prev = latest.get(e.pubkey);
        if (!prev || prev.created_at < e.created_at) latest.set(e.pubkey, e);
      }
      return [...latest.values()].map(parseProfile);
    },
  });
}

/**
 * Post search over the latest notes, filtered in the browser. The relay's
 * full-text index doesn't cover kind 1, so this only sees recent posts.
 */
export function usePostSearch(query: string) {
  const q = query.trim().toLowerCase();
  return useQuery({
    queryKey: ["feed", "search-posts", q],
    enabled: q.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const events = await fetchEvents({
        kinds: [KIND_NOTE],
        limit: SEARCH_SCAN_LIMIT,
      });
      return sortNewestFirst(events)
        .filter((e) => e.content.toLowerCase().includes(q))
        .slice(0, 50)
        .map(toPost);
    },
  });
}
