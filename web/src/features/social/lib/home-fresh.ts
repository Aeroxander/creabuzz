/**
 * What is new on Home: the posts that arrived since the reader opened it (shown behind "N new posts. Show", never
 * pushed into what they are reading), and where their last visit ended (the "New since your last visit" line in the
 * newest-first orders).
 *
 * Pure and alias-free: `home-fresh.test.mjs` drives it under `node --test`.
 */

import type { BoardEvent } from "../../board/lib/board-model.ts";
import type { TimelineItem } from "./mixed-timeline.ts";
import type { Row } from "./timeline.ts";

/** How often Home asks for newer posts while it is on screen. */
export const FRESH_POLL_MS = 45_000;

/** Board posts (kind 45001), as `board-events.ts` names them; repeated here to stay alias-free and light. */
const KIND_BOARD_POST = 45001;

/**
 * Where the next check for newer posts starts, per kind of post: the newest of that kind shown, or `openedAt` (when
 * the reader opened Home) when none is. Inclusive: a post in the same second as the newest shown is still found, and
 * left out by id if it is the one shown.
 */
export function freshSince(
  items: readonly TimelineItem[],
  openedAt: number,
): { notes: number; boards: number } {
  let notes = Number.NEGATIVE_INFINITY;
  let boards = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.kind === "note") notes = Math.max(notes, item.at);
    else boards = Math.max(boards, item.at);
  }
  return {
    notes: Number.isFinite(notes) ? notes : openedAt,
    boards: Number.isFinite(boards) ? boards : openedAt,
  };
}

/** What a check for newer posts found, before it is checked against what is shown. */
export interface FreshFound {
  rows: readonly Row[];
  boardPosts: readonly BoardEvent[];
  /** More arrived than one read returns: showing them means reading Home again from the top. */
  capped: boolean;
}

/** The new posts the bar offers, newest first. */
export interface FreshPosts {
  rows: Row[];
  boardPosts: BoardEvent[];
  capped: boolean;
  count: number;
}

/**
 * The found posts the reader would see and does not yet: top-level short posts and posts on boards they can see,
 * not already shown (a repost of a shown post is not new), not theirs (their own post shows as soon as it is accepted),
 * and not by or reposted by someone they muted. Removed and deleted posts never come back from the server, and a
 * repost of one is left out when it is read (`buildRows`).
 */
export function freshToShow(
  found: FreshFound,
  context: {
    shown: readonly TimelineItem[];
    boards: ReadonlySet<string>;
    muted: ReadonlySet<string>;
    me: string | null;
  },
): FreshPosts {
  const shownNotes = new Set<string>();
  const shownBoardPosts = new Set<string>();
  for (const item of context.shown) {
    if (item.kind === "note") shownNotes.add(item.row.event.id);
    else shownBoardPosts.add(item.post.id);
  }
  const hidden = (pubkey: string | undefined) =>
    pubkey !== undefined &&
    (pubkey === context.me || context.muted.has(pubkey));

  const seenNotes = new Set<string>();
  const rows = found.rows
    .filter(
      (row) =>
        row.replyToId === null &&
        !shownNotes.has(row.event.id) &&
        !hidden(row.event.pubkey) &&
        !hidden(row.repostedBy?.pubkey) &&
        !seenNotes.has(row.event.id) &&
        seenNotes.add(row.event.id),
    )
    .sort(
      (a, b) =>
        (b.repostedBy?.at ?? b.event.created_at) -
        (a.repostedBy?.at ?? a.event.created_at),
    );
  const seenPosts = new Set<string>();
  const boardPosts = found.boardPosts
    .filter((post) => {
      const board = post.tags.find((tag) => tag[0] === "h")?.[1];
      return (
        post.kind === KIND_BOARD_POST &&
        board !== undefined &&
        context.boards.has(board) &&
        !shownBoardPosts.has(post.id) &&
        !hidden(post.pubkey) &&
        !seenPosts.has(post.id) &&
        seenPosts.add(post.id)
      );
    })
    .sort((a, b) => b.created_at - a.created_at);
  return {
    rows,
    boardPosts,
    capped: found.capped,
    count: rows.length + boardPosts.length,
  };
}

/** When a found post was posted (a repost: when it was reposted), the time a check's `since` reads by. */
export function freshAt(row: Row): number {
  return row.repostedBy?.at ?? row.event.created_at;
}

/**
 * Where the next check starts reading, given what this one read from `start`. Posts the reader is never offered
 * (replies, reposts of shown posts, muted people's posts) must not pile up in every later read until one read is full
 * of them. So once a check read everything since `start` (not capped), the next starts at the oldest post it offers,
 * which keeps finding those, or, offering none, at the newest it read. A capped read may have left posts unread below
 * the ones it returned, so the start stays (the bar offers to read Home again from the top). Never moves back.
 */
export function nextFreshStart(
  start: number,
  read: { newest: number | null; capped: boolean },
  offeredAt: readonly number[],
): number {
  if (read.capped) return start;
  if (offeredAt.length > 0) return Math.max(start, Math.min(...offeredAt));
  return read.newest === null ? start : Math.max(start, read.newest);
}

/**
 * The bar offers Show when there are new posts, and also when a check found more than one read returns, even if none
 * of the ones it returned would be shown: posts may be waiting below them, and Show reading Home again from the top is
 * then the reader's only way to them.
 */
export function freshOffered(fresh: {
  count: number;
  capped: boolean;
}): boolean {
  return fresh.capped || fresh.count > 0;
}

/** The bar's words. */
export function freshLabel(fresh: { count: number; capped: boolean }): string {
  if (fresh.capped) return "Many new posts";
  return fresh.count === 1 ? "1 new post" : `${fresh.count} new posts`;
}

/**
 * Show the new posts on top of what is shown, newest first, keeping the order of everything else. `top` is the keys
 * already put on top this way (newest first); the result is the new list of them.
 */
export function withFreshOnTop(
  top: readonly string[],
  added: readonly string[],
): string[] {
  const have = new Set(top);
  return [...added.filter((key) => !have.has(key)), ...top];
}

/** The order to draw: the keys put on top first, then the held order without them. */
export function orderWithTop(
  top: readonly string[],
  held: readonly string[],
): string[] {
  const onTop = new Set(top);
  return [...top, ...held.filter((key) => !onTop.has(key))];
}

/** Whether a timeline item is drawn for a reader who muted `muted` (as `PostList` draws it). */
export function notMuted(muted: ReadonlySet<string>) {
  return (item: TimelineItem): boolean =>
    item.kind === "board"
      ? !muted.has(item.post.author)
      : !muted.has(item.row.event.pubkey) &&
        !(item.row.repostedBy && muted.has(item.row.repostedBy.pubkey));
}

/* ── Last visit ─────────────────────────────────────────────────────────── */

/** One record per account and server: the same person on two servers has two last visits. */
export function lastVisitKey(server: string, account: string): string {
  return `buzz.home.last-seen.${server}.${account}`;
}

/** The last visit as it was when this page loaded, per server and account: Home writes the new one as it is read. */
const atLoad = new Map<string, number | null>();

/**
 * When the reader's last visit ended, read once per page load: leaving Home for a thread and coming back keeps the
 * line where it was, instead of moving it to what this visit just stored.
 */
export function lastVisitAtLoad(
  server: string,
  account: string,
): number | null {
  const key = lastVisitKey(server, account);
  if (!atLoad.has(key)) atLoad.set(key, readLastVisit(server, account));
  return atLoad.get(key) ?? null;
}

/** When the reader's last visit ended (the newest post they were shown), or null on a first visit. */
export function readLastVisit(server: string, account: string): number | null {
  try {
    const stored = Number(
      globalThis.localStorage?.getItem(lastVisitKey(server, account)),
    );
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Remember the newest post the reader was shown. It only moves forward, and never past `now`: a post dated in the
 * future (a wrong clock) must not hide the next visit's new posts.
 */
export function writeLastVisit(
  server: string,
  account: string,
  at: number,
  now: number,
): void {
  const value = Math.min(at, now);
  if (!(value > 0)) return;
  try {
    const key = lastVisitKey(server, account);
    const stored = Number(globalThis.localStorage?.getItem(key)) || 0;
    if (value > stored) globalThis.localStorage?.setItem(key, String(value));
  } catch {
    // Storage refused (a private window): the next visit just has no line.
  }
}

/** The newest post time in a list, or null for an empty one. */
export function newestAt(items: readonly { at: number }[]): number | null {
  let newest: number | null = null;
  for (const item of items) {
    if (newest === null || item.at > newest) newest = item.at;
  }
  return newest;
}

/**
 * Where the "New since your last visit" line goes in a newest-first list: before the first post at or before the
 * last visit, when at least one newer post is above it. Null on a first visit, or when everything is new or nothing is.
 */
export function lastVisitDivider(
  items: readonly { key: string; at: number }[],
  lastVisit: number | null,
): string | null {
  if (lastVisit === null) return null;
  const index = items.findIndex((item) => item.at <= lastVisit);
  return index > 0 ? (items[index]?.key ?? null) : null;
}
