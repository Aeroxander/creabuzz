/**
 * One timeline from two kinds of post: short posts (kind 1 notes, General) and board posts (each on its board).
 *
 * Everyone is ranked on one scale: recency lifted by engagement (`trust.ts` `rankScore`). A note's engagement is its
 * trust-weighted votes, reposts and replies; a board post's is its votes plus half its replies (board votes count one
 * each). Following is newest first.
 *
 * The two kinds are read in pages of their own. While older notes remain unread, a board post older than the oldest
 * note read is held back, so the end of the list never jumps ahead to old board posts and leaves a gap of notes; it
 * comes in when the notes reach it.
 *
 * Pure and alias-free: `mixed-timeline.test.mjs` drives it under `node --test`.
 */

import type { FeedPost } from "../../board/lib/board-feed.ts";
import type { Row } from "./timeline.ts";
import { activityAt } from "./timeline.ts";

export type TimelineItem =
  | { kind: "note"; key: string; row: Row; at: number }
  | { kind: "board"; key: string; post: FeedPost; at: number };

/** A board post's engagement on the ranking scale. Decision posts are never ranked by votes. */
export function boardEngagement(post: FeedPost): number {
  const votes = post.proposal ? 0 : post.score;
  return votes + 0.5 * Math.min(post.commentCount, 50);
}

function items(
  rows: readonly Row[],
  posts: readonly FeedPost[],
  notesComplete: boolean,
): TimelineItem[] {
  const notes: TimelineItem[] = rows.map((row) => ({
    kind: "note",
    key: `n:${row.event.id}:${row.repostedBy?.pubkey ?? ""}`,
    row,
    at: activityAt(row),
  }));
  const oldestNote = notes.reduce(
    (min, item) => Math.min(min, item.at),
    Number.POSITIVE_INFINITY,
  );
  const cutoff = notesComplete || notes.length === 0 ? -Infinity : oldestNote;
  const boards: TimelineItem[] = posts
    .filter((post) => post.createdAt >= cutoff)
    .map((post) => ({
      kind: "board",
      key: `b:${post.id}`,
      post,
      at: post.createdAt,
    }));
  return [...notes, ...boards];
}

function tieBreak(a: TimelineItem, b: TimelineItem): number {
  return b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Newest first (Following). */
export function mixChronological(
  rows: readonly Row[],
  posts: readonly FeedPost[],
  notesComplete: boolean,
): TimelineItem[] {
  return items(rows, posts, notesComplete).sort(tieBreak);
}

/** Highest score first (Everyone). `scoreOf` is the shared ranking scale. */
export function mixRanked(
  rows: readonly Row[],
  posts: readonly FeedPost[],
  notesComplete: boolean,
  scoreOf: (item: TimelineItem) => number,
): TimelineItem[] {
  const all = items(rows, posts, notesComplete);
  const score = new Map(all.map((item) => [item.key, scoreOf(item)]));
  return all.sort(
    (a, b) =>
      (score.get(b.key) ?? 0) - (score.get(a.key) ?? 0) || tieBreak(a, b),
  );
}
