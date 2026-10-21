/**
 * Board posts whose title or text has the words searched for, from the newest board posts on this server, with their
 * votes and replies so they show like any other board post. Search for short posts works the same way
 * (`social/use-discovery.ts`), so both kinds are found alike.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useCallback } from "react";

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

/** How many of the newest board posts are searched, and how many matches are shown. */
const SCAN_LIMIT = 1000;
const MATCH_LIMIT = 30;

export function useBoardSearch(query: string) {
  const q = query.trim().toLowerCase();
  const channels = useChannels();
  const found = useQuery({
    queryKey: ["board-search", q],
    enabled: q.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<BoardEvent[]> => {
      const url = relayWsUrl();
      const posts = (
        await queryEvents(url, { kinds: [KIND_FORUM_POST], limit: SCAN_LIMIT })
      )
        .filter((post) => post.content.toLowerCase().includes(q))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, MATCH_LIMIT);
      if (posts.length === 0) return [];
      const ids = posts.map((post) => post.id);
      const [votes, comments] = await Promise.all([
        queryEvents(url, { kinds: [KIND_FORUM_VOTE], "#e": ids, limit: 3000 }),
        queryEvents(url, {
          kinds: [KIND_FORUM_COMMENT],
          "#e": ids,
          limit: 3000,
        }),
      ]);
      return [...posts, ...votes, ...comments];
    },
  });
  // The reader's own votes from the results, merged in as soon as the server accepts them.
  const [mine, setMine] = useState<Map<string, BoardEvent>>(() => new Map());
  const add = useCallback(
    (event: BoardEvent) =>
      setMine((previous) => new Map(previous).set(event.id, event)),
    [],
  );
  const boards = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const channel of channels.channels)
      if (channel.type === "forum") map.set(channel.id, { name: channel.name });
    return map;
  }, [channels.channels]);
  const me = existingUserPubkey();
  const posts = useMemo<FeedPost[]>(() => {
    const byId = new Map<string, BoardEvent>();
    for (const event of found.data ?? []) byId.set(event.id, event);
    for (const event of mine.values()) byId.set(event.id, event);
    return buildFeed([...byId.values()], me, new Set(boards.keys()));
  }, [found.data, mine, me, boards]);

  return {
    posts,
    boards,
    add,
    isLoading: found.isLoading || channels.isLoading,
    error: found.error,
  };
}
