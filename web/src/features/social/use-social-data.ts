import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";

import {
  KIND_CONTACT_LIST,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import type { NostrEvent } from "@/shared/lib/nostr-client";

import { latestList } from "../feed/lib/lists";
import { followedPeople } from "../feed/lib/lists";
import { computeEngagement, lastTagValue } from "./lib/engagement";
import {
  buildRows,
  repostTargetsToFetch,
  type Row,
  type SignedEvent,
} from "./lib/timeline";
import { readEvents } from "./read";

const PAGE_SIZE = 40;
const MAX_ANCESTORS = 6;

export const socialKeys = {
  all: ["social"] as const,
  engagement: ["social", "engagement"] as const,
  lists: ["social", "lists"] as const,
};

interface RowsPage {
  rows: Row[];
  next: number | null;
}

async function fetchRowsPage(options: {
  authors?: string[] | null;
  filter?: Record<string, string[]>;
  reposts: boolean;
  until?: number;
}): Promise<RowsPage> {
  const events = (await readEvents({
    kinds: options.reposts ? [KIND_TEXT_NOTE, KIND_REPOST] : [KIND_TEXT_NOTE],
    limit: PAGE_SIZE,
    ...(options.authors ? { authors: options.authors } : {}),
    ...options.filter,
    ...(options.until ? { until: options.until } : {}),
  })) as SignedEvent[];

  // A repost without an authentic embedded copy needs its original fetched.
  const missing = repostTargetsToFetch(events);
  const fetched = missing.length
    ? ((await readEvents({
        ids: missing,
        kinds: [KIND_TEXT_NOTE],
        limit: missing.length,
      })) as SignedEvent[])
    : [];
  const rows = buildRows(events, new Map(fetched.map((e) => [e.id, e])));
  const oldest = events.reduce(
    (min, e) => Math.min(min, e.created_at),
    Number.POSITIVE_INFINITY,
  );
  return {
    rows,
    next:
      events.length >= PAGE_SIZE && Number.isFinite(oldest) ? oldest - 1 : null,
  };
}

/**
 * A reverse-chronological timeline, paged by `until`. `authors` narrows it to
 * a follow list or one profile; `filter` adds relay-side tag constraints (a
 * hashtag); `select` post-filters each page (top-level only, replies only,
 * media only).
 */
export function useTimeline({
  key,
  authors,
  filter,
  reposts = false,
  select = (row) => row.replyToId === null,
  enabled = true,
}: {
  key: unknown[];
  authors?: string[] | null;
  filter?: Record<string, string[]>;
  reposts?: boolean;
  select?: (row: Row) => boolean;
  enabled?: boolean;
}) {
  return useInfiniteQuery<
    RowsPage,
    Error,
    InfiniteData<RowsPage>,
    unknown[],
    number | undefined
  >({
    queryKey: [...socialKeys.all, "timeline", ...key],
    enabled: enabled && !(authors && authors.length === 0),
    initialPageParam: undefined,
    staleTime: 15_000,
    queryFn: async ({ pageParam }) => {
      const page = await fetchRowsPage({
        authors,
        filter,
        reposts,
        until: pageParam,
      });
      return { ...page, rows: page.rows.filter(select) };
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export async function fetchEngagement(
  ids: readonly string[],
  viewer: string | null,
) {
  const [related, quotes] = await Promise.all([
    readEvents({
      kinds: [KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE],
      "#e": [...ids],
      limit: 1000,
    }),
    readEvents({ kinds: [KIND_TEXT_NOTE], "#q": [...ids], limit: 500 }),
  ]);
  return computeEngagement(ids, [...related, ...quotes], viewer);
}

/** Likes, reposts, quotes and replies for a handful of notes. */
export function useEngagement(ids: readonly string[], viewer: string | null) {
  const key = [...new Set(ids)].sort();
  return useQuery({
    queryKey: [...socialKeys.engagement, key, viewer],
    enabled: key.length > 0,
    staleTime: 15_000,
    queryFn: () => fetchEngagement(key, viewer),
  });
}

/** Notes by id, in the order asked for (likes, bookmarks, a quoted note). */
export function useNotesById(ids: readonly string[]) {
  const key = [...new Set(ids)];
  return useQuery({
    queryKey: [...socialKeys.all, "notes", key.join(",")],
    enabled: key.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const events = (await readEvents({
        ids: key,
        kinds: [KIND_TEXT_NOTE],
        limit: key.length,
      })) as SignedEvent[];
      const byId = new Map(events.map((e) => [e.id, e]));
      return buildRows(key.flatMap((id) => byId.get(id) ?? []));
    },
  });
}

/** A note, the notes above it (oldest first) and its direct replies. */
export function useThread(noteId: string) {
  return useQuery({
    queryKey: [...socialKeys.all, "thread", noteId],
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      const [found, replies] = await Promise.all([
        readEvents({ ids: [noteId], kinds: [KIND_TEXT_NOTE], limit: 1 }),
        readEvents({ kinds: [KIND_TEXT_NOTE], "#e": [noteId], limit: 200 }),
      ]);
      const note = buildRows(found as SignedEvent[])[0] ?? null;

      const ancestors: Row[] = [];
      let parentId = note?.replyToId ?? null;
      while (parentId && ancestors.length < MAX_ANCESTORS) {
        const [parent] = (await readEvents({
          ids: [parentId],
          kinds: [KIND_TEXT_NOTE],
          limit: 1,
        })) as SignedEvent[];
        const row = parent ? buildRows([parent])[0] : null;
        if (!row) break;
        ancestors.unshift(row);
        parentId = row.replyToId;
      }

      const direct = buildRows(replies as SignedEvent[])
        .filter((r) => r.replyToId === noteId)
        .sort((a, b) => a.event.created_at - b.event.created_at);
      return { note, ancestors, replies: direct };
    },
  });
}

/** Who a person follows, from their newest contact list. */
export function useFollowing(pubkey: string | null) {
  return useQuery({
    queryKey: [...socialKeys.lists, "following", pubkey],
    enabled: pubkey !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const events = await readEvents({
        kinds: [KIND_CONTACT_LIST],
        authors: [pubkey as string],
        limit: 5,
      });
      return [
        ...followedPeople(
          latestList(events, KIND_CONTACT_LIST, pubkey as string),
        ),
      ];
    },
  });
}

/** How many accounts' newest contact list follows `pubkey` (capped at the scan). */
export function useFollowerCount(pubkey: string) {
  return useQuery({
    queryKey: [...socialKeys.lists, "followers", pubkey],
    staleTime: 60_000,
    queryFn: async () => {
      const limit = 1000;
      const events = await readEvents({
        kinds: [KIND_CONTACT_LIST],
        "#p": [pubkey],
        limit,
      });
      return {
        count: new Set(events.map((e: NostrEvent) => e.pubkey)).size,
        capped: events.length >= limit,
      };
    },
  });
}

/** Ids of notes a person liked, newest first. */
export function useLikedIds(pubkey: string) {
  return useQuery({
    queryKey: [...socialKeys.all, "liked", pubkey],
    staleTime: 30_000,
    queryFn: async () => {
      const events = await readEvents({
        kinds: [KIND_REACTION],
        authors: [pubkey],
        limit: 200,
      });
      return [
        ...new Set(
          events
            .filter((e) => e.content === "+" || e.content === "")
            .sort((a, b) => b.created_at - a.created_at)
            .flatMap((e) => lastTagValue(e.tags, "e") ?? []),
        ),
      ];
    },
  });
}
