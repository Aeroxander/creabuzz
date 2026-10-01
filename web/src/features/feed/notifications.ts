import type { NostrEvent } from "@/shared/lib/nostr-client";
import {
  KIND_CONTACTS,
  KIND_NOTE,
  KIND_REACTION,
  KIND_REPOST,
  lastTagValue,
  parentIdOf,
  tagValues,
} from "./feed-model";

export type NotificationKind =
  | "like"
  | "repost"
  | "reply"
  | "mention"
  | "follow";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actor: string;
  at: number;
  /** The viewer's note this is about (like/repost/reply target), when there is one. */
  targetId: string | null;
  /** The actor's own note for replies and mentions. */
  noteId: string | null;
}

/** Events that tag `viewer` (`#p`) → notification rows, newest first. */
export function buildNotifications(
  events: NostrEvent[],
  viewer: string,
): NotificationItem[] {
  const seen = new Set<string>();
  const follows = new Map<string, NotificationItem>();
  const items: NotificationItem[] = [];

  for (const e of events) {
    if (e.pubkey === viewer || seen.has(e.id)) continue;
    seen.add(e.id);

    if (e.kind === KIND_CONTACTS) {
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
    } else if (e.kind === KIND_NOTE) {
      const parent = parentIdOf(e);
      items.push({
        id: e.id,
        kind: parent ? "reply" : "mention",
        actor: e.pubkey,
        at: e.created_at,
        targetId: parent,
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

/** Collapse likes/reposts on the same note into one row ("A, B and 3 others liked …"). */
export function groupNotifications(
  items: NotificationItem[],
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

const seenKey = (viewer: string) => `buzz-notifications-seen:${viewer}`;

export function readSeenAt(viewer: string): number {
  try {
    return Number(localStorage.getItem(seenKey(viewer))) || 0;
  } catch {
    return 0;
  }
}

export function writeSeenAt(viewer: string, at: number): void {
  try {
    localStorage.setItem(seenKey(viewer), String(at));
  } catch {
    // Storage unavailable (private mode) — unread badge just won't persist.
  }
}
