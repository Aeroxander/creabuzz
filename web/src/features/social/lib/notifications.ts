/**
 * Social notifications: what people did to you, from the events that tag you
 * (`#p`), and on boards from the replies and votes that name your board posts
 * and replies (board records name what they answer, not who wrote it). Up votes
 * and reposts on the same post collapse into one row; a down vote is not a
 * notification. Pure and alias-free: `social.test.mjs` drives it under
 * `node --test`.
 */

import {
  KIND_CONTACT_LIST,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import { parseNote, type SignedEventLike } from "../../feed/lib/feed-events.ts";
import { splitPost } from "../../board/lib/post-text.ts";
import { lastTagValue, tagValues } from "./engagement.ts";

const KIND_BOARD_POST = 45001;
const KIND_BOARD_VOTE = 45002;
const KIND_BOARD_REPLY = 45003;

export type NotificationKind =
  | "like"
  | "repost"
  | "quote"
  | "reply"
  | "mention"
  | "follow"
  | "board-reply"
  | "board-upvote"
  | "moderation";

/**
 * A moderator's notice about you (a removal, a board mute), worded by `moderationItem`. A board's notice opens the
 * board, and for a removed reply the conversation it was in; a Home notice has no board, and for a removed reply opens
 * the Home conversation. A removed post has nothing left to open.
 */
export interface ModerationNotice {
  title: string;
  preview: string;
  boardId: string | null;
  threadId: string | null;
}

/** Where a board notification opens: the board, the post the conversation is under, and a line to show. */
export interface BoardRef {
  boardId: string;
  /** The board post at the top of the conversation. */
  postId: string;
  /** For an up vote, your post's title or your reply; for a reply, what they wrote. */
  text: string;
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actor: string;
  at: number;
  /** Your note a like / repost / reply / quote is about. */
  targetId: string | null;
  /** The actor's own note, for replies, quotes and mentions. */
  noteId: string | null;
  /** Set for board replies and votes. */
  board?: BoardRef;
  /** Set for a moderator's notice about you. */
  notice?: ModerationNotice;
}

function tagOf(tags: readonly string[][], name: string): string | null {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value !== "" ? value : null;
}

/** A board reply's post (`root`, or its only `e`) and what it directly answers (`reply`, else the post). */
function boardReplyTarget(
  tags: readonly string[][],
): { postId: string; parent: string } | null {
  const refs = tags.filter((tag) => tag[0] === "e" && tag[1]);
  if (refs.length === 0) return null;
  const marked = (marker: string) => refs.find((tag) => tag[3] === marker)?.[1];
  const postId = marked("root") ?? marked("reply") ?? refs[0][1];
  return { postId, parent: marked("reply") ?? postId };
}

/**
 * Board notifications for `viewer`: replies that answer one of `mine` (their board posts and replies) and up votes on
 * them. `related` is whatever names those records; anything else in it is ignored.
 */
export function buildBoardNotifications(
  mine: readonly SignedEventLike[],
  related: readonly SignedEventLike[],
  viewer: string,
): NotificationItem[] {
  const own = new Map<
    string,
    { boardId: string; postId: string; text: string }
  >();
  for (const e of mine) {
    if (e.pubkey !== viewer) continue;
    const boardId = tagOf(e.tags, "h");
    if (!boardId) continue;
    if (e.kind === KIND_BOARD_POST) {
      own.set(e.id, {
        boardId,
        postId: e.id,
        text: splitPost(e.content).title,
      });
    } else if (e.kind === KIND_BOARD_REPLY) {
      const target = boardReplyTarget(e.tags);
      if (target)
        own.set(e.id, { boardId, postId: target.postId, text: e.content });
    }
  }
  const seen = new Set<string>();
  const items: NotificationItem[] = [];
  for (const e of related) {
    if (e.pubkey === viewer || seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.kind === KIND_BOARD_REPLY) {
      const target = boardReplyTarget(e.tags);
      const answered = target ? own.get(target.parent) : undefined;
      if (!target || !answered) continue;
      items.push({
        id: e.id,
        kind: "board-reply",
        actor: e.pubkey,
        at: e.created_at,
        targetId: target.parent,
        noteId: null,
        board: {
          boardId: answered.boardId,
          postId: answered.postId,
          text: e.content,
        },
      });
    } else if (e.kind === KIND_BOARD_VOTE && e.content === "+") {
      const targetId = lastTagValue(e.tags, "e") ?? "";
      const voted = own.get(targetId);
      if (!voted) continue;
      items.push({
        id: e.id,
        kind: "board-upvote",
        actor: e.pubkey,
        at: e.created_at,
        targetId,
        noteId: null,
        board: voted,
      });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

/**
 * Notifications without the ones a muted person caused: a mute hides them here too, so the count does not count them.
 * A moderator's notice about you is never hidden: a mute is about whom you hear from, not about your own access.
 */
export function withoutMuted<T extends { actor: string; kind?: string }>(
  items: readonly T[],
  muted: ReadonlySet<string>,
): T[] {
  return muted.size === 0
    ? [...items]
    : items.filter(
        (item) =>
          item.kind === "moderation" || !muted.has(item.actor.toLowerCase()),
      );
}

/** Events that tag `viewer` → notifications, newest first. */

export function buildNotifications(
  events: readonly SignedEventLike[],
  viewer: string,
): NotificationItem[] {
  const seen = new Set<string>();
  const follows = new Map<string, NotificationItem>();
  const items: NotificationItem[] = [];

  for (const e of events) {
    if (e.pubkey === viewer || seen.has(e.id)) continue;
    seen.add(e.id);

    if (e.kind === KIND_CONTACT_LIST) {
      if (!tagValues(e.tags, "p").includes(viewer)) continue;
      const prev = follows.get(e.pubkey);
      if (!prev || prev.at < e.created_at) {
        follows.set(e.pubkey, {
          id: e.id,
          kind: "follow",
          actor: e.pubkey,
          at: e.created_at,
          targetId: null,
          noteId: null,
        });
      }
    } else if (e.kind === KIND_REACTION) {
      if (e.content !== "+" && e.content !== "") continue;
      items.push({
        id: e.id,
        kind: "like",
        actor: e.pubkey,
        at: e.created_at,
        targetId: lastTagValue(e.tags, "e") ?? null,
        noteId: null,
      });
    } else if (e.kind === KIND_REPOST) {
      items.push({
        id: e.id,
        kind: "repost",
        actor: e.pubkey,
        at: e.created_at,
        targetId: lastTagValue(e.tags, "e") ?? null,
        noteId: null,
      });
    } else if (e.kind === KIND_TEXT_NOTE) {
      const note = parseNote(e);
      const quoted = lastTagValue(e.tags, "q");
      const kind: NotificationKind = note?.replyToId
        ? "reply"
        : quoted
          ? "quote"
          : "mention";
      items.push({
        id: e.id,
        kind,
        actor: e.pubkey,
        at: e.created_at,
        targetId: note?.replyToId ?? quoted ?? null,
        noteId: e.id,
      });
    }
  }
  return [...items, ...follows.values()].sort((a, b) => b.at - a.at);
}

export interface NotificationGroup {
  key: string;
  kind: NotificationKind;
  actors: string[];
  at: number;
  targetId: string | null;
  noteId: string | null;
  board?: BoardRef;
  notice?: ModerationNotice;
}

/** Collapse up votes and reposts on one post into a single row. */
export function groupNotifications(
  items: readonly NotificationItem[],
): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const byKey = new Map<string, NotificationGroup>();
  for (const item of items) {
    const groupable =
      (item.kind === "like" ||
        item.kind === "repost" ||
        item.kind === "board-upvote") &&
      item.targetId;
    const key = groupable ? `${item.kind}:${item.targetId}` : item.id;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.actors.includes(item.actor))
        existing.actors.push(item.actor);
      continue;
    }
    const group: NotificationGroup = {
      key,
      kind: item.kind,
      actors: [item.actor],
      at: item.at,
      targetId: item.targetId,
      noteId: item.noteId,
      ...(item.board ? { board: item.board } : {}),
      ...(item.notice ? { notice: item.notice } : {}),
    };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

const seenKey = (viewer: string) => `buzz.social.notifications.seen.${viewer}`;

export function readSeenAt(viewer: string): number {
  try {
    return Number(globalThis.localStorage?.getItem(seenKey(viewer))) || 0;
  } catch {
    return 0;
  }
}

export function writeSeenAt(viewer: string, at: number): void {
  try {
    globalThis.localStorage?.setItem(seenKey(viewer), String(at));
  } catch {
    // Storage refused: the unread badge just does not persist this visit.
  }
}
