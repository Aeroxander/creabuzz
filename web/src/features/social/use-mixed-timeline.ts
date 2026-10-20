/**
 * Home's timeline: short posts (General) and board posts in one list. Everyone is ranked on one scale (recency lifted
 * by votes, reposts and replies); Following is the people you follow, newest first, from General and every board.
 *
 * The order is taken when a new set of posts arrives (first load, an older page, a refresh) and when the ranking
 * becomes known, never on a vote, so the post under the reader's cursor does not move; counts change in place.
 */

import { useMemo, useRef } from "react";

import { useBoardFeed } from "../board/use-board-feed";
import { type FeedPeriod, withinPeriod } from "../board/lib/board-feed";
import {
  boardEngagement,
  mixChronological,
  mixRanked,
  type TimelineItem,
} from "./lib/mixed-timeline";
import type { BoardContext } from "./ui/PostList";
import { useNoteRanking } from "./use-ranking";
import { useTimeline } from "./use-social-data";

export type TimelineSort = "hot" | "new" | "top";

export function useMixedTimeline({
  tab,
  authors,
  enabled,
  sort = "hot",
  period = "week",
}: {
  tab: "everyone" | "following";
  /** For Following: the people followed, the reader included. Null for Everyone. */
  authors: string[] | null;
  enabled: boolean;
  /** Everyone's order: Hot (recency lifted by votes), New, or Top within `period`. Following is always newest first. */
  sort?: TimelineSort;
  period?: FeedPeriod;
}) {
  const authorKey = authors ? [...authors].sort().join(",") : "all";
  const notes = useTimeline({
    key: [tab, authorKey],
    authors,
    reposts: true,
    enabled,
  });
  const board = useBoardFeed({
    authors: tab === "following" ? (authors ?? []) : null,
    enabled,
  });
  const rows = useMemo(
    () => notes.data?.pages.flatMap((page) => page.rows) ?? [],
    [notes.data],
  );
  const ranking = useNoteRanking(
    rows,
    tab === "everyone" && sort !== "new" && enabled,
  );
  const notesComplete = !notes.hasNextPage;

  const sorted = useMemo<TimelineItem[]>(() => {
    if (tab === "following" || sort === "new" || !ranking.ready) {
      return mixChronological(rows, board.posts, notesComplete);
    }
    if (sort === "top") {
      const now = Math.floor(Date.now() / 1000);
      const inPeriod = (at: number) =>
        withinPeriod([{ createdAt: at }], period, now).length > 0;
      return mixRanked(
        rows.filter((row) => inPeriod(row.event.created_at)),
        board.posts.filter((post) => inPeriod(post.createdAt)),
        notesComplete,
        (item) =>
          item.kind === "note"
            ? ranking.engagementOf(item.row.event.id)
            : boardEngagement(item.post),
      );
    }
    return mixRanked(rows, board.posts, notesComplete, (item) =>
      item.kind === "note"
        ? ranking.scoreNote(item.row)
        : ranking.scoreOf(boardEngagement(item.post), item.post.createdAt),
    );
  }, [tab, sort, period, ranking, rows, board.posts, notesComplete]);

  // Hold the order still between new sets of posts.
  const held = useRef<{ signature: string; order: string[] } | null>(null);
  const signature = `${tab}|${sort}|${period}|${ranking.ready}|${sorted
    .map((item) => item.key)
    .sort()
    .join(",")}`;
  if (held.current?.signature !== signature) {
    held.current = { signature, order: sorted.map((item) => item.key) };
  }
  const order = held.current.order;
  const items = useMemo(() => {
    const byKey = new Map(sorted.map((item) => [item.key, item]));
    return order
      .map((key) => byKey.get(key))
      .filter((item): item is TimelineItem => item !== undefined);
  }, [order, sorted]);

  const boards: BoardContext = useMemo(
    () => ({ names: board.boards, add: board.add }),
    [board.boards, board.add],
  );

  return {
    items,
    boards,
    isLoading: notes.isLoading || board.isLoading,
    error: notes.error ?? board.error,
    refetch: () => {
      void notes.refetch();
      board.refetch();
    },
    hasMore: notes.hasNextPage || board.hasOlder,
    loadingMore: notes.isFetchingNextPage || board.loadingOlder,
    loadMore: () => {
      if (notes.hasNextPage && !notes.isFetchingNextPage)
        void notes.fetchNextPage();
      // Board posts are read further back only once the notes have caught up with the oldest one read.
      const oldestBoard = board.posts.reduce(
        (min, post) => Math.min(min, post.createdAt),
        Number.POSITIVE_INFINITY,
      );
      const oldestNote = rows.reduce(
        (min, row) => Math.min(min, row.event.created_at),
        Number.POSITIVE_INFINITY,
      );
      if (board.hasOlder && (!notes.hasNextPage || oldestNote <= oldestBoard))
        board.loadOlder();
    },
  };
}
