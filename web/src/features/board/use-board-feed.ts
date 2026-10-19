/**
 * Posts from many boards at once, with their votes and replies, for the boards front page on Home and the hot posts
 * in Everyone.
 *
 * Read a page at a time, newest first: each page is the next posts (the server keeps them to the boards this reader may
 * see, or to the boards asked for), then the votes and replies that name those posts. Older pages are read on request.
 * While it is open, new posts by other people are counted live but not shown until asked for, so the list never moves
 * under the reader; what the reader does (a vote) is merged in as soon as the server accepts it.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useChannels } from "@/features/channels/use-channels";
import {
  subscribeChannel,
  type SubscriptionStatus,
} from "@/features/channels/subscribe-channel";
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

function postFilter(boards: readonly string[] | null): NostrFilter {
  return boards === null
    ? { kinds: [KIND_FORUM_POST] }
    : { kinds: [KIND_FORUM_POST], "#h": boards.slice(0, MAX_NAMED_BOARDS) };
}

async function fetchPage(
  boards: readonly string[] | null,
  until: number | undefined,
): Promise<FeedPage> {
  const url = relayWsUrl();
  const posts = await queryEvents(url, {
    ...postFilter(boards),
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
  boards: ReadonlyMap<string, { name: string; description: string }>;
  isLoading: boolean;
  error: unknown;
  /** Read everything again from the newest, taking in any new posts. */
  refetch: () => void;
  /** Merge in a record the server just accepted (the reader's own vote or post). */
  add: (event: BoardEvent) => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** Posts by other people that arrived while open and are not shown yet. */
  fresh: number;
  liveStatus: SubscriptionStatus | null;
}

/**
 * `scope` is the boards to read, or null for every board the reader can see. `enabled` false reads nothing (a scope
 * still being worked out). `live` false skips the live count of new posts.
 */
export function useBoardFeed({
  scope = null,
  enabled = true,
  live = true,
}: {
  scope?: readonly string[] | null;
  enabled?: boolean;
  live?: boolean;
} = {}): BoardFeed {
  const channels = useChannels();
  const scopeKey = scope === null ? "all" : [...scope].sort().join(",");
  // Rebuilt from the key, so a new array with the same boards does not start the read again.
  const named = useMemo(
    () =>
      scopeKey === "all" ? null : scopeKey === "" ? [] : scopeKey.split(","),
    [scopeKey],
  );
  const empty = named !== null && named.length === 0;
  const query = useInfiniteQuery({
    queryKey: ["board-feed", scopeKey],
    queryFn: ({ pageParam }) => fetchPage(named, pageParam),
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
    const map = new Map<string, { name: string; description: string }>();
    for (const channel of channels.channels) {
      if (channel.type !== "forum") continue;
      map.set(channel.id, {
        name: channel.name,
        description: channel.description,
      });
    }
    return map;
  }, [channels.channels]);

  // New posts while open: counted, not shown, until the reader asks.
  const me = existingUserPubkey();
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  const [liveStatus, setLiveStatus] = useState<SubscriptionStatus | null>(null);
  // The server pushes a board's new posts only to subscriptions that name the board, so "every board" is spelled out
  // from the board list (up to the server's cap on named boards).
  const liveKey =
    named === null
      ? [...boards.keys()].sort().slice(0, MAX_NAMED_BOARDS).join(",")
      : scopeKey;
  useEffect(() => {
    setArrived(new Set());
    setLiveStatus(null);
    if (!enabled || empty || !live || liveKey === "") return;
    const since = Math.floor(Date.now() / 1000);
    return subscribeChannel(
      relayWsUrl(),
      { kinds: [KIND_FORUM_POST], "#h": liveKey.split(","), since },
      {
        onEvent: (event) => {
          if (event.kind !== KIND_FORUM_POST || event.pubkey === me) return;
          setArrived((previous) => new Set(previous).add(event.id));
        },
        onStatus: setLiveStatus,
      },
    );
  }, [liveKey, enabled, empty, live, me]);

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

  const shownIds = useMemo(() => new Set(posts.map((p) => p.id)), [posts]);
  const fresh = [...arrived].filter((id) => !shownIds.has(id)).length;

  return {
    posts,
    boards,
    isLoading: (!empty && enabled && query.isLoading) || channels.isLoading,
    error: query.error ?? channels.error,
    refetch: () => {
      setArrived(new Set());
      void query.refetch();
      void channels.refetch();
    },
    add,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => {
      if (!query.isFetchingNextPage) void query.fetchNextPage();
    },
    fresh,
    liveStatus,
  };
}
