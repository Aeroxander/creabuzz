/**
 * The newest posts from every board the reader can open on this server, with
 * their votes and replies, for the boards front page on Home.
 *
 * Three bounded reads: the newest posts (the server keeps them to the boards
 * this reader may see), then the votes and replies that name those posts. It is
 * a snapshot, refreshed when asked or when the reader comes back to it; what the
 * reader does here (a vote) is merged in as soon as the server accepts it. A
 * single board, opened, is live (`use-board.ts`).
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useChannels } from "@/features/channels/use-channels";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
} from "./lib/board-events";
import { buildFeed, type FeedPost } from "./lib/board-feed";
import type { BoardEvent } from "./lib/board-model";

/** Bounds on one read. Past these the feed shows the newest, and says so. */
export const FEED_POST_LIMIT = 150;
const FEED_COMMENT_LIMIT = 3000;
const FEED_VOTE_LIMIT = 5000;

async function fetchFeed(): Promise<BoardEvent[]> {
  const url = relayWsUrl();
  const posts = await queryEvents(url, {
    kinds: [KIND_FORUM_POST],
    limit: FEED_POST_LIMIT,
  });
  if (posts.length === 0) return [];
  const ids = posts.map((post) => post.id);
  const [votes, comments] = await Promise.all([
    queryEvents(url, {
      kinds: [KIND_FORUM_VOTE],
      "#e": ids,
      limit: FEED_VOTE_LIMIT,
    }),
    queryEvents(url, {
      kinds: [KIND_FORUM_COMMENT],
      "#e": ids,
      limit: FEED_COMMENT_LIMIT,
    }),
  ]);
  return [...posts, ...votes, ...comments];
}

export interface BoardFeed {
  posts: FeedPost[];
  /** Board id → its name and description, for the chip on each post. */
  boards: ReadonlyMap<string, { name: string; description: string }>;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  /** Merge in a record the server just accepted (the reader's own vote). */
  add: (event: BoardEvent) => void;
  /** The newest posts only: there were more than one read returns. */
  truncated: boolean;
}

export function useBoardFeed(): BoardFeed {
  const channels = useChannels();
  const query = useQuery({
    queryKey: ["board-feed"],
    queryFn: fetchFeed,
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

  const me = existingUserPubkey();
  const posts = useMemo(() => {
    const byId = new Map<string, BoardEvent>();
    for (const event of query.data ?? []) byId.set(event.id, event);
    for (const event of mine.values()) byId.set(event.id, event);
    return buildFeed([...byId.values()], me, new Set(boards.keys()));
  }, [query.data, mine, me, boards]);

  return {
    posts,
    boards,
    isLoading: query.isLoading || channels.isLoading,
    error: query.error ?? channels.error,
    refetch: () => {
      void query.refetch();
      void channels.refetch();
    },
    add,
    truncated:
      (query.data ?? []).filter((e) => e.kind === KIND_FORUM_POST).length >=
      FEED_POST_LIMIT,
  };
}
