/**
 * Board posts by id, with their votes and replies, for a list that names posts rather than boards (the reader's
 * bookmarks). Only posts on a board the reader can see named are kept, as the Home feed does; ids that are not board
 * posts are simply not found.
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

const VOTE_LIMIT = 5000;
const COMMENT_LIMIT = 3000;

async function readPosts(ids: readonly string[]): Promise<BoardEvent[]> {
  const url = relayWsUrl();
  const posts = await queryEvents(url, {
    ids: [...ids],
    kinds: [KIND_FORUM_POST],
    limit: ids.length,
  });
  if (posts.length === 0) return [];
  const found = posts.map((post) => post.id);
  const [votes, comments] = await Promise.all([
    queryEvents(url, {
      kinds: [KIND_FORUM_VOTE],
      "#e": found,
      limit: VOTE_LIMIT,
    }),
    queryEvents(url, {
      kinds: [KIND_FORUM_COMMENT],
      "#e": found,
      limit: COMMENT_LIMIT,
    }),
  ]);
  return [...posts, ...votes, ...comments];
}

export function useBoardPostsById(ids: readonly string[]) {
  const key = [...new Set(ids)].sort();
  const channels = useChannels();
  const query = useQuery({
    queryKey: ["board-posts-by-id", key.join(",")],
    queryFn: () => readPosts(key),
    enabled: key.length > 0,
    staleTime: 30_000,
  });

  const [mine, setMine] = useState<Map<string, BoardEvent>>(() => new Map());
  const add = useCallback(
    (event: BoardEvent) =>
      setMine((previous) => new Map(previous).set(event.id, event)),
    [],
  );

  const names = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const channel of channels.channels)
      if (channel.type === "forum") map.set(channel.id, { name: channel.name });
    return map;
  }, [channels.channels]);

  const me = existingUserPubkey();
  const posts = useMemo<FeedPost[]>(() => {
    const byId = new Map<string, BoardEvent>();
    for (const event of query.data ?? []) byId.set(event.id, event);
    for (const event of mine.values()) byId.set(event.id, event);
    return buildFeed([...byId.values()], me, new Set(names.keys()));
  }, [query.data, mine, me, names]);

  return {
    posts,
    names,
    add,
    isLoading: key.length > 0 && (query.isLoading || channels.isLoading),
  };
}
