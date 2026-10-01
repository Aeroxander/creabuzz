import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { parseEntity } from "@/shared/lib/nip19";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  KIND_NOTE,
  KIND_PROFILE,
  KIND_REACTION,
  type Post,
  type Profile,
  computeMeta,
  hashtagsOf,
  mentionEntitiesOf,
  parentIdOf,
  parseProfile,
  sortNewestFirst,
  toPost,
} from "./feed-model";
import { MOCK_VIEWER, queryMockEvents } from "./mock-feed";
import { publishEvent } from "./publish-event";

const PAGE_SIZE = 30;
const MAX_ANCESTORS = 6;

/** Dev-only mock mode (`?preview=feed`); sticks for the tab session so in-app navigation keeps it. */
export function isFeedPreview(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    if (new URLSearchParams(window.location.search).get("preview") === "feed") {
      sessionStorage.setItem("buzz-feed-preview", "1");
    }
    return sessionStorage.getItem("buzz-feed-preview") === "1";
  } catch {
    return false;
  }
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

export async function fetchEvents(
  filter: Parameters<typeof queryEvents>[1],
): Promise<NostrEvent[]> {
  if (isFeedPreview()) return queryMockEvents(filter);
  return queryEvents(relayWsUrl(), filter);
}

/** Newest event of a replaceable kind for an author, or null. */
export async function fetchLatest(
  kind: number,
  author: string,
): Promise<NostrEvent | null> {
  const events = await fetchEvents({
    kinds: [kind],
    authors: [author],
    limit: 5,
  });
  return [...events].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

type TimelinePage = { posts: Post[]; next: number | null };

/**
 * Reverse-chronological notes. `authors` narrows to a follow list; `filter`
 * adds relay-side constraints (e.g. a `#t` hashtag); `select` post-filters
 * each page (top-level only, replies only, media only, …).
 */
export function useTimeline({
  key,
  authors,
  filter,
  select = (p) => p.parentId === null,
  enabled = true,
}: {
  key: unknown[];
  authors?: string[] | null;
  filter?: Record<string, string[]>;
  select?: (post: Post) => boolean;
  enabled?: boolean;
}) {
  return useInfiniteQuery<
    TimelinePage,
    Error,
    InfiniteData<TimelinePage>,
    unknown[],
    number | undefined
  >({
    queryKey: ["feed", "timeline", ...key],
    enabled:
      enabled &&
      (authors === undefined || authors === null || authors.length > 0),
    initialPageParam: undefined,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async ({ pageParam }) => {
      const events = await fetchEvents({
        kinds: [KIND_NOTE],
        limit: PAGE_SIZE,
        ...(authors ? { authors } : {}),
        ...filter,
        ...(pageParam ? { until: pageParam } : {}),
      });
      const sorted = sortNewestFirst(events);
      const oldest = sorted[sorted.length - 1]?.created_at;
      return {
        posts: sorted.map(toPost).filter(select),
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
      const events = await fetchEvents({
        kinds: [KIND_PROFILE],
        authors: key,
        limit: key.length * 2,
      });
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
        fetchEvents({ kinds: [KIND_NOTE], "#e": key, limit: 500 }),
      ]);
      return computeMeta(key, [...reactions, ...replies], viewer);
    },
  });
}

/** Notes by id (bookmarks, likes). Order follows `ids`. */
export function usePostsByIds(ids: string[]) {
  const key = ids.join(",");
  return useQuery({
    queryKey: ["feed", "posts-by-id", key],
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const events = await fetchEvents({
        ids,
        kinds: [KIND_NOTE],
        limit: ids.length,
      });
      const byId = new Map(events.map((e) => [e.id, e]));
      return ids.flatMap((id) => {
        const e = byId.get(id);
        return e ? [toPost(e)] : [];
      });
    },
  });
}

/** The note, its replies, and up to a few ancestors (oldest first). */
export function useThread(noteId: string) {
  return useQuery({
    queryKey: ["feed", "thread", noteId],
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      const [root, replies] = await Promise.all([
        fetchEvents({ ids: [noteId], kinds: [KIND_NOTE], limit: 1 }),
        fetchEvents({ kinds: [KIND_NOTE], "#e": [noteId], limit: 200 }),
      ]);
      const note = root[0] ? toPost(root[0]) : null;

      const ancestors: Post[] = [];
      let parentId = note?.parentId ?? null;
      while (parentId && ancestors.length < MAX_ANCESTORS) {
        const [parent] = await fetchEvents({
          ids: [parentId],
          kinds: [KIND_NOTE],
          limit: 1,
        });
        if (!parent) break;
        ancestors.unshift(toPost(parent));
        parentId = parentIdOf(parent);
      }

      return {
        root: note,
        ancestors,
        replies: sortNewestFirst(replies)
          .reverse()
          .map(toPost)
          .filter((p) => p.parentId === noteId),
      };
    },
  });
}

export type ReplyTarget = {
  id: string;
  author: string;
  rootId?: string | null;
};

function mentionTags(content: string): string[][] {
  return mentionEntitiesOf(content).flatMap((entity) => {
    const parsed = parseEntity(entity);
    return parsed?.type === "pubkey" ? [["p", parsed.pubkey]] : [];
  });
}

/** Tags for a new note: NIP-10 reply markers, `p` mentions, `t` hashtags. */
export function buildNoteTags(content: string, replyTo?: ReplyTarget) {
  const tags: string[][] = [];
  if (replyTo) {
    if (replyTo.rootId && replyTo.rootId !== replyTo.id) {
      tags.push(["e", replyTo.rootId, "", "root"]);
    }
    tags.push(["e", replyTo.id, "", "reply"]);
    tags.push(["p", replyTo.author]);
  }
  for (const tag of mentionTags(content)) {
    if (!tags.some((t) => t[0] === "p" && t[1] === tag[1])) tags.push(tag);
  }
  for (const t of hashtagsOf(content)) tags.push(["t", t]);
  return tags;
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
      replyTo?: ReplyTarget;
    }) => {
      if (isFeedPreview()) throw new Error("Posting is disabled in preview.");
      return publishEvent({
        kind: KIND_NOTE,
        content,
        tags: buildNoteTags(content, replyTo),
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
