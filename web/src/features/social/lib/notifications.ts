/**
 * Social notifications: what people did to you, from the events that tag you
 * (`#p`). Likes and reposts on the same note collapse into one row. Pure and
 * alias-free: `social.test.mjs` drives it under `node --test`.
 */

import {
  KIND_CONTACT_LIST,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import { parseNote, type SignedEventLike } from "../../feed/lib/feed-events.ts";
import { lastTagValue, tagValues } from "./engagement.ts";

export type NotificationKind =
  | "like"
  | "repost"
  | "quote"
  | "reply"
  | "mention"
  | "follow";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actor: string;
  at: number;
  /** Your note a like / repost / reply / quote is about. */
  targetId: string | null;
  /** The actor's own note, for replies, quotes and mentions. */
  noteId: string | null;
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
}

/** Collapse likes / reposts on one note into a single row. */
export function groupNotifications(
  items: readonly NotificationItem[],
): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const byKey = new Map<string, NotificationGroup>();
  for (const item of items) {
    const groupable =
      (item.kind === "like" || item.kind === "repost") && item.targetId;
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
