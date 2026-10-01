import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  KIND_CONTACTS,
  KIND_NOTE,
  KIND_PROFILE,
  KIND_REACTION,
  type PostMeta,
  type Post,
  computeMeta,
  parseProfile,
  sortNewestFirst,
  toPost,
  type Profile,
} from "./feed-model";
import { MOCK_VIEWER, mockNotes, mockProfiles, mockReplies } from "./mock-feed";
import { publishEvent } from "./publish-event";

const PAGE_SIZE = 30;

export function isFeedPreview(): boolean {
  return (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("preview") === "feed"
  );
}

/** Pubkey of the NIP-07 identity, or null when no extension is available. */
export function useViewerPubkey(): string | null {
  const [pubkey, setPubkey] = useState<string | null>(
    isFeedPreview() ? MOCK_VIEWER : null,
  );
  useEffect(() => {
    if (isFeedPreview()) return;
    let cancelled = false;
    window.nostr
      ?.getPublicKey()
      .then((pk) => {
        if (!cancelled) setPubkey(pk);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return pubkey;
}

async function fetchEvents(
  filter: Parameters<typeof queryEvents>[1],
  mock: NostrEvent[] = [],
): Promise<NostrEvent[]> {
  if (isFeedPreview()) return mock;
  return queryEvents(relayWsUrl(), filter);
}

export function useFollows(viewer: string | null) {
  return useQuery({
    queryKey: ["feed", "follows", viewer],
    enabled: viewer !== null,
    staleTime: 60_000,
    queryFn: async () => {
      if (!viewer) return [];
      const events = await fetchEvents({
        kinds: [KIND_CONTACTS],
        authors: [viewer],
        limit: 1,
      });
      const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
      return (latest?.tags ?? [])
        .filter((t) => t[0] === "p" && t[1])
        .map((t) => t[1]);
    },
  });
}

/** Reverse-chronological timeline of top-level notes. `authors` narrows to a follow list. */
export function useTimeline(authors: string[] | null) {
  return useInfiniteQuery<
    { posts: Post[]; next: number | null },
    Error,
    InfiniteData<{ posts: Post[]; next: number | null }>,
    unknown[],
    number | undefined
  >({
    queryKey: ["feed", "timeline", authors ? [...authors].sort() : "global"],
    enabled: authors === null || authors.length > 0,
    initialPageParam: undefined,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async ({ pageParam }) => {
      const events = await fetchEvents(
        {
          kinds: [KIND_NOTE],
          limit: PAGE_SIZE,
          ...(authors ? { authors } : {}),
          ...(pageParam ? { until: pageParam } : {}),
        },
        mockNotes,
      );
      const sorted = sortNewestFirst(events);
      const oldest = sorted[sorted.length - 1]?.created_at;
      return {
        posts: sorted.map(toPost).filter((p) => p.parentId === null),
        next: events.length >= PAGE_SIZE && oldest ? oldest - 1 : null,
      };
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

/** Profiles (kind 0) for a set of authors. */
export function useProfiles(pubkeys: string[]) {
  const key = [...new Set(pubkeys)].sort();
  return useQuery({
    queryKey: ["feed", "profiles", key],
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const events = await fetchEvents(
        { kinds: [KIND_PROFILE], authors: key, limit: key.length * 2 },
        mockProfiles,
      );
      const latest = new Map<string, NostrEvent>();
      for (const e of events) {
        const prev = latest.get(e.pubkey);
        if (!prev || e.created_at > prev.created_at) latest.set(e.pubkey, e);
      }
      return new Map<string, Profile>(
        [...latest].map(([pk, e]) => [pk, parseProfile(e)]),
      );
    },
  });
}

/** Reply and like counts for a batch of notes. */
export function usePostMeta(ids: string[], viewer: string | null) {
  const key = [...ids].sort();
  return useQuery({
    queryKey: ["feed", "meta", key, viewer],
    enabled: key.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const [reactions, replies] = await Promise.all([
        fetchEvents({ kinds: [KIND_REACTION], "#e": key, limit: 500 }),
        fetchEvents({ kinds: [KIND_NOTE], "#e": key, limit: 500 }, mockReplies),
      ]);
      return computeMeta(key, [...reactions, ...replies], viewer);
    },
  });
}

export function useThread(noteId: string) {
  return useQuery({
    queryKey: ["feed", "thread", noteId],
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      const [root, replies] = await Promise.all([
        fetchEvents(
          { ids: [noteId], kinds: [KIND_NOTE], limit: 1 },
          mockNotes.filter((e) => e.id === noteId),
        ),
        fetchEvents(
          { kinds: [KIND_NOTE], "#e": [noteId], limit: 200 },
          mockReplies.filter((e) => e.tags.some((t) => t[1] === noteId)),
        ),
      ]);
      return {
        root: root[0] ? toPost(root[0]) : null,
        replies: sortNewestFirst(replies)
          .reverse()
          .map(toPost)
          .filter((p) => p.parentId === noteId),
      };
    },
  });
}

/** Publish a note, optionally as a reply, then refresh the affected queries. */
export function usePublishNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      content,
      replyTo,
    }: {
      content: string;
      replyTo?: { id: string; author: string };
    }) => {
      if (isFeedPreview()) throw new Error("Posting is disabled in preview.");
      return publishEvent({
        kind: KIND_NOTE,
        content,
        tags: replyTo
          ? [
              ["e", replyTo.id, "", "reply"],
              ["p", replyTo.author],
            ]
          : [],
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["feed"] }),
  });
}

export function useLikeNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (note: { id: string; author: string }) => {
      if (isFeedPreview()) throw new Error("Liking is disabled in preview.");
      return publishEvent({
        kind: KIND_REACTION,
        content: "+",
        tags: [
          ["e", note.id],
          ["p", note.author],
        ],
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["feed", "meta"] }),
  });
}

export type { PostMeta };
