/**
 * A board as the reader sees it, worked out from the records the server holds:
 * posts with their score, their comments and their last activity, ordered the
 * way the reader asked, and kept steady while they read.
 *
 * Votes. A person's vote on something is their latest vote on it, so changing
 * your mind is one more vote and taking it back is deleting your vote record
 * (the server then no longer returns it). A vote is a signal from a person, one
 * each; it is not a DAO vote and is never weighted.
 *
 * Deletions. The server stops returning what an author deletes, so most of this
 * file never sees a deleted record; it still honours a deletion that arrives
 * live, and only when the person deleting is the author of what is deleted.
 *
 * Alias-free; `board-model.test.mjs` drives it under `node --test`.
 */

import {
  KIND_DELETION,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
} from "./board-events.ts";
import { splitPost } from "./post-text.ts";
import {
  PROPOSAL_TOPIC,
  type ProposalRef,
  proposalOf,
} from "./proposal-link.ts";

export interface BoardEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface BoardPost {
  id: string;
  author: string;
  createdAt: number;
  title: string;
  body: string;
  /** Plain topics (the `t` tags that are not the proposal link). */
  topics: string[];
  /** The decision this post says it is about, if it names exactly one. */
  proposal: ProposalRef | null;
  score: number;
  /** The reader's own vote: 1, -1 or 0. */
  myVote: 1 | -1 | 0;
  /**
   * Every vote record the reader has written on this, newest first. Taking a
   * vote back, or changing it, deletes all of them: deleting only the latest
   * would let an earlier one count again.
   */
  myVoteIds: string[];
  commentCount: number;
  /** The newest of the post and its comments. */
  lastActivity: number;
}

export interface BoardComment {
  id: string;
  author: string;
  createdAt: number;
  body: string;
  /** The comment this answers, when it answers a comment rather than the post. */
  replyTo: string | null;
  score: number;
  myVote: 1 | -1 | 0;
  myVoteIds: string[];
}

export interface Board {
  posts: BoardPost[];
  /** Each post's comments, oldest first. */
  comments: Map<string, BoardComment[]>;
}

function tagValue(tags: readonly string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

/** Where a comment points: the post (`root`) and what it directly answers (`parent`). */
function replyTarget(
  tags: readonly string[][],
): { root: string; parent: string } | null {
  const refs = tags.filter(
    (tag) => tag[0] === "e" && typeof tag[1] === "string",
  );
  if (refs.length === 0) return null;
  const marked = (marker: string) => refs.find((tag) => tag[3] === marker)?.[1];
  const root = marked("root") ?? marked("reply") ?? refs[0][1];
  const parent = marked("reply") ?? root;
  return { root, parent };
}

function newer(a: BoardEvent, b: BoardEvent): boolean {
  return (
    a.created_at > b.created_at ||
    (a.created_at === b.created_at && a.id > b.id)
  );
}

/** Every vote on each target, grouped by author, newest first. */
function votesByTarget(
  events: readonly BoardEvent[],
): Map<string, Map<string, BoardEvent[]>> {
  const byTarget = new Map<string, Map<string, BoardEvent[]>>();
  for (const event of events) {
    if (event.kind !== KIND_FORUM_VOTE) continue;
    if (event.content !== "+" && event.content !== "-") continue;
    const target = tagValue(event.tags, "e");
    if (!target) continue;
    const authors = byTarget.get(target) ?? new Map<string, BoardEvent[]>();
    const list = authors.get(event.pubkey) ?? [];
    list.push(event);
    authors.set(event.pubkey, list);
    byTarget.set(target, authors);
  }
  for (const authors of byTarget.values()) {
    for (const list of authors.values()) {
      list.sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
    }
  }
  return byTarget;
}

/** A person's vote is their newest one; the score is one vote each. */
function tally(
  votes: Map<string, BoardEvent[]> | undefined,
  me: string | null,
) {
  let score = 0;
  let myVote: 1 | -1 | 0 = 0;
  let myVoteIds: string[] = [];
  for (const [voter, list] of votes ?? []) {
    const value = list[0].content === "+" ? 1 : -1;
    score += value;
    if (me !== null && voter === me) {
      myVote = value;
      myVoteIds = list.map((vote) => vote.id);
    }
  }
  return { score, myVote, myVoteIds };
}

/** Ids removed by a deletion their own author sent. */
function deletedIds(events: readonly BoardEvent[]): Set<string> {
  const authors = new Map(events.map((event) => [event.id, event.pubkey]));
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== KIND_DELETION) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "e" || typeof tag[1] !== "string") continue;
      if (authors.get(tag[1]) === event.pubkey) deleted.add(tag[1]);
    }
  }
  return deleted;
}

export function buildBoard(
  events: readonly BoardEvent[],
  me: string | null,
): Board {
  const deleted = deletedIds(events);
  const live = events.filter((event) => !deleted.has(event.id));
  const votes = votesByTarget(live);

  const comments = new Map<string, BoardComment[]>();
  const lastActivity = new Map<string, number>();
  const postEvents = live.filter((event) => event.kind === KIND_FORUM_POST);
  const postIds = new Set(postEvents.map((event) => event.id));
  const commentIds = new Set<string>();

  for (const event of live) {
    if (event.kind !== KIND_FORUM_COMMENT) continue;
    const target = replyTarget(event.tags);
    // A comment on something we do not have (or that was deleted) has nowhere to show.
    if (!target || !postIds.has(target.root)) continue;
    commentIds.add(event.id);
    const list = comments.get(target.root) ?? [];
    list.push({
      id: event.id,
      author: event.pubkey,
      createdAt: event.created_at,
      body: event.content,
      replyTo: target.parent === target.root ? null : target.parent,
      ...tally(votes.get(event.id), me),
    });
    comments.set(target.root, list);
    lastActivity.set(
      target.root,
      Math.max(lastActivity.get(target.root) ?? 0, event.created_at),
    );
  }
  for (const list of comments.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    // An answer to a comment that is gone reads as an answer to the post.
    for (const comment of list) {
      if (comment.replyTo !== null && !commentIds.has(comment.replyTo))
        comment.replyTo = null;
    }
  }

  const posts: BoardPost[] = postEvents.map((event) => {
    const { title, body } = splitPost(event.content);
    const topics = event.tags
      .filter(
        (tag) =>
          tag[0] === "t" &&
          typeof tag[1] === "string" &&
          tag[1] !== PROPOSAL_TOPIC,
      )
      .map((tag) => tag[1])
      .filter((topic) => !topic.startsWith(`${PROPOSAL_TOPIC}:`));
    return {
      id: event.id,
      author: event.pubkey,
      createdAt: event.created_at,
      title,
      body,
      topics,
      proposal: proposalOf(event.tags),
      commentCount: comments.get(event.id)?.length ?? 0,
      lastActivity: Math.max(event.created_at, lastActivity.get(event.id) ?? 0),
      ...tally(votes.get(event.id), me),
    };
  });
  return { posts, comments };
}

export type BoardSort = "active" | "new" | "top";
export type BoardFilter = "all" | "proposals";

export const SORT_LABELS: Record<BoardSort, string> = {
  active: "Active",
  new: "New",
  top: "Top",
};

/**
 * `priority` (lower first) puts some posts ahead of the rest before the sort applies: a proposal board uses it to
 * show decisions that can still change first. Posts it does not name sort after those it does.
 */
export function sortPosts(
  posts: readonly BoardPost[],
  sort: BoardSort,
  priority?: ReadonlyMap<string, number>,
): BoardPost[] {
  const key = (post: BoardPost): number[] => {
    const rank = priority
      ? [priority.get(post.id) ?? Number.MAX_SAFE_INTEGER]
      : [];
    return [
      ...rank,
      ...(sort === "active"
        ? [post.lastActivity, post.createdAt]
        : sort === "new"
          ? [post.createdAt]
          : // Votes never rank a proposal: it shows none, and a vote here is not the DAO's vote.
            [post.proposal ? 0 : post.score, post.createdAt]),
    ];
  };
  return [...posts].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] === kb[i]) continue;
      // The priority is the one key where smaller comes first.
      return priority && i === 0 ? ka[i] - kb[i] : kb[i] - ka[i];
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export function filterPosts(
  posts: readonly BoardPost[],
  filter: BoardFilter,
): BoardPost[] {
  return filter === "proposals"
    ? posts.filter((post) => post.proposal !== null)
    : [...posts];
}

export interface Arrangement {
  rows: BoardPost[];
  /** The order being shown; keep it and pass it back as `frozen` to hold the list still. */
  order: string[];
  /** Posts by other people that arrived since the order was taken, not shown yet. */
  fresh: number;
  /** The shown posts would sit differently if sorted now. */
  reordered: boolean;
}

/**
 * Order the list the way the reader asked, and hold it still while they read.
 *
 * Counts and scores update live, but a post does not jump because someone
 * replied to it, and other people's new posts wait behind a "show" button; the
 * reader's own post goes straight to the top. `frozen` is the order taken when
 * the list was last (re)arranged; null means arrange afresh.
 */
export function arrange(input: {
  posts: readonly BoardPost[];
  sort: BoardSort;
  frozen: readonly string[] | null;
  me: string | null;
  priority?: ReadonlyMap<string, number>;
}): Arrangement {
  const ideal = sortPosts(input.posts, input.sort, input.priority);
  if (input.frozen === null) {
    return {
      rows: ideal,
      order: ideal.map((p) => p.id),
      fresh: 0,
      reordered: false,
    };
  }
  const byId = new Map(input.posts.map((post) => [post.id, post]));
  const known = new Set(input.frozen);
  const kept = input.frozen
    .map((id) => byId.get(id))
    .filter((p): p is BoardPost => p !== undefined);
  const mine = input.posts
    .filter(
      (post) =>
        !known.has(post.id) && input.me !== null && post.author === input.me,
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const rows = [...mine, ...kept];
  const shown = new Set(rows.map((p) => p.id));
  const fresh = input.posts.filter(
    (post) => !known.has(post.id) && !shown.has(post.id),
  ).length;
  const idealShown = ideal
    .filter((post) => shown.has(post.id))
    .map((post) => post.id);
  const reordered = idealShown.some((id, i) => id !== rows[i].id);
  return { rows, order: rows.map((p) => p.id), fresh, reordered };
}
