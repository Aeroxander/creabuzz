/**
 * Posts from many boards at once, with their votes and replies, for the boards front page on Home and the hot posts
 * in Everyone.
 *
 * Read a page at a time, newest first: each page is the next posts (the server keeps them to the boards this reader may
 * see, or to the boards asked for), then the votes and replies that name those posts. Older pages are read on request;
 * what the reader does (a vote) is merged in as soon as the server accepts it. A single board, opened, is live
 * (`use-board.ts`).
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useChannels } from "@/features/channels/use-channels";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type NostrFilter, queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
} from "./lib/board-events";
import { buildFeed, type FeedPost } from "./lib/board-feed";
import type { BoardEvent } from "./lib/board-model";

/** Posts per page. */
export const FEED_PAGE_SIZE = 100;
const COMMENT_LIMIT = 3000;
const VOTE_LIMIT = 5000;
/** The server refuses a read that names more boards than this. */
const MAX_NAMED_BOARDS = 128;

interface FeedPage {
  events: BoardEvent[];
  /** The oldest post's time, where the next page starts; null when this page was the last. */
  next: number | null;
}

function postFilter(
  boards: readonly string[] | null,
  authors: readonly string[] | null,
): NostrFilter {
  return {
    kinds: [KIND_FORUM_POST],
    ...(boards === null ? {} : { "#h": boards.slice(0, MAX_NAMED_BOARDS) }),
    ...(authors === null ? {} : { authors: [...authors] }),
  };
}

async function fetchPage(
  boards: readonly string[] | null,
  authors: readonly string[] | null,
  until: number | undefined,
): Promise<FeedPage> {
  const url = relayWsUrl();
  const posts = await queryEvents(url, {
    ...postFilter(boards, authors),
    limit: FEED_PAGE_SIZE,
    ...(until === undefined ? {} : { until }),
  });
  if (posts.length === 0) return { events: [], next: null };
  const ids = posts.map((post) => post.id);
  const [votes, comments] = await Promise.all([
    queryEvents(url, {
      kinds: [KIND_FORUM_VOTE],
      "#e": ids,
      limit: VOTE_LIMIT,
    }),
    queryEvents(url, {
      kinds: [KIND_FORUM_COMMENT],
      "#e": ids,
      limit: COMMENT_LIMIT,
    }),
  ]);
  const times = posts.map((post) => post.created_at);
  const oldest = Math.min(...times);
  // `until` is inclusive: the next page starts at the oldest second read, so posts sharing it are not skipped (the
  // repeats are merged by id). Only a page that is all one second has to step past it to make progress.
  const allOneSecond = times.every((time) => time === oldest);
  return {
    events: [...posts, ...votes, ...comments],
    next:
      posts.length < FEED_PAGE_SIZE ? null : allOneSecond ? oldest - 1 : oldest,
  };
}

export interface BoardFeed {
  posts: FeedPost[];
  /** Board id → its name and description, for the chip on each post. */
  boards: ReadonlyMap<
    string,
    { name: string; description: string; visibility: "public" | "private" }
  >;
  isLoading: boolean;
  /** Only the list of boards is still being read (the posts may come later): what a list of boards waits for. */
  boardsLoading: boolean;
  error: unknown;
  /** Read everything again from the newest, taking in any new posts. */
  refetch: () => void;
  /** Merge in a record the server just accepted (the reader's own vote or post). */
  add: (event: BoardEvent) => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

/**
 * `scope` is the boards to read, or null for every board the reader can see. `enabled` false reads nothing (a scope
 * still being worked out). `authors` keeps only posts by those people (the Following timeline).
 */
export function useBoardFeed({
  scope = null,
  authors = null,
  enabled = true,
}: {
  scope?: readonly string[] | null;
  authors?: readonly string[] | null;
  enabled?: boolean;
} = {}): BoardFeed {
  const channels = useChannels();
  const scopeKey = scope === null ? "all" : [...scope].sort().join(",");
  // Rebuilt from the key, so a new array with the same boards does not start the read again.
  const named = useMemo(
    () =>
      scopeKey === "all" ? null : scopeKey === "" ? [] : scopeKey.split(","),
    [scopeKey],
  );
  const authorKey = authors === null ? "anyone" : [...authors].sort().join(",");
  const byAuthors = useMemo(
    () =>
      authorKey === "anyone"
        ? null
        : authorKey === ""
          ? []
          : authorKey.split(","),
    [authorKey],
  );
  const empty =
    (named !== null && named.length === 0) ||
    (byAuthors !== null && byAuthors.length === 0);
  const query = useInfiniteQuery({
    queryKey: ["board-feed", scopeKey, authorKey],
    queryFn: ({ pageParam }) => fetchPage(named, byAuthors, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: enabled && !empty,
    staleTime: 30_000,
  });

  const [mine, setMine] = useState<Map<string, BoardEvent>>(() => new Map());
  const add = useCallback(
    (event: BoardEvent) =>
      setMine((previous) => new Map(previous).set(event.id, event)),
    [],
  );

  const boards = useMemo(() => {
    const map = new Map<
      string,
      { name: string; description: string; visibility: "public" | "private" }
    >();
    for (const channel of channels.channels) {
      if (channel.type !== "forum") continue;
      map.set(channel.id, {
        name: channel.name,
        description: channel.description,
        visibility: channel.visibility,
      });
    }
    return map;
  }, [channels.channels]);

  const me = existingUserPubkey();
  const loaded = query.data?.pages;
  const posts = useMemo(() => {
    const byId = new Map<string, BoardEvent>();
    for (const page of loaded ?? [])
      for (const event of page.events) byId.set(event.id, event);
    for (const event of mine.values()) byId.set(event.id, event);
    const visible = new Set(boards.keys());
    if (named !== null)
      for (const id of visible) if (!named.includes(id)) visible.delete(id);
    return buildFeed([...byId.values()], me, visible);
  }, [loaded, mine, me, boards, named]);

  return {
    posts,
    boards,
    isLoading: (!empty && enabled && query.isLoading) || channels.isLoading,
    boardsLoading: channels.isLoading,
    error: query.error ?? channels.error,
    refetch: () => {
      void query.refetch();
      void channels.refetch();
    },
    add,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => {
      if (!query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}
