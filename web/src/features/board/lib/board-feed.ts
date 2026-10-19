/**
 * Every board's posts in one list, the way a front page of boards reads: each
 * post knows which board it is on, and the list is ordered Hot, New or Top.
 *
 * Hot is score lifted by recency: a post needs about ten times the votes to
 * stay level with one twelve and a half hours younger, so a busy post stays up
 * for a day or two and a quiet board's new post still reaches the top. Replies
 * count a little, so a discussion people are having rises before anyone votes.
 * New is newest first. Top is the highest score among the posts read.
 *
 * Posts about a DAO decision are not ranked by votes anywhere (a vote here is
 * not the DAO's vote), so they sit in Hot by recency and replies only.
 *
 * Alias-free; `board-feed.test.mjs` drives it under `node --test`.
 */

import { KIND_FORUM_POST } from "./board-events.ts";
import { type BoardEvent, type BoardPost, buildBoard } from "./board-model.ts";

export type FeedSort = "hot" | "new" | "top";

export const FEED_SORT_LABELS: Record<FeedSort, string> = {
  hot: "Hot",
  new: "New",
  top: "Top",
};

export interface FeedPost extends BoardPost {
  /** The board (channel id, the post's `h` tag) the post is on. */
  boardId: string;
}

/** Seconds of age that cost as much as a tenfold drop in votes. */
const HOT_HALF_STEP = 45_000;

/** Higher is hotter. Pure in `now` so the order can be tested and held still. */
export function hotScore(post: BoardPost, now: number): number {
  const votes = post.proposal ? 0 : post.score;
  const lift = votes + Math.min(post.commentCount, 50) / 2;
  const sign = lift > 0 ? 1 : lift < 0 ? -1 : 0;
  const order = Math.log10(Math.max(Math.abs(lift), 1));
  // Age measured back from now, so the number stays small and comparable.
  const age = Math.max(0, now - post.createdAt);
  return sign * order - age / HOT_HALF_STEP;
}

export function sortFeed(
  posts: readonly FeedPost[],
  sort: FeedSort,
  now: number,
): FeedPost[] {
  const key = (post: FeedPost): number =>
    sort === "hot"
      ? hotScore(post, now)
      : sort === "top"
        ? post.proposal
          ? 0
          : post.score
        : post.createdAt;
  return [...posts].sort((a, b) => {
    const diff = key(b) - key(a);
    if (diff !== 0) return diff;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Posts from any number of boards, with their votes and replies, as one list.
 * Only posts on a board in `boards` are kept: a post whose board the reader
 * cannot see named (or that is not a board at all) has nowhere to open.
 */
export function buildFeed(
  events: readonly BoardEvent[],
  me: string | null,
  boards: ReadonlySet<string>,
): FeedPost[] {
  const boardOfPost = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== KIND_FORUM_POST) continue;
    const h = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (typeof h === "string" && boards.has(h)) boardOfPost.set(event.id, h);
  }
  return buildBoard(events, me)
    .posts.filter((post) => boardOfPost.has(post.id))
    .map((post) => ({ ...post, boardId: boardOfPost.get(post.id) ?? "" }));
}

/** The first words of a body as plain text, for a preview under the title. */
export function previewText(body: string, max = 220): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
