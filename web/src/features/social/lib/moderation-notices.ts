/**
 * A moderator's notices about the reader (a removal, a board mute), as rows on the Home Notifications page. The server
 * writes these log entries itself and names the person they are about, so the reader's own are read by their key; the
 * wording is `moderationItem`'s, the same the community bell uses. Pure and alias-free: `moderation-notices.test.mjs`
 * drives it under `node --test`.
 */

import {
  KIND_BOARD_MODERATION_LOG,
  moderationItem,
} from "../../notifications/lib/moderation-items.ts";
import type { NotificationItem } from "./notifications.ts";

export { KIND_BOARD_MODERATION_LOG };

/** How many of the reader's newest notices are read. */
export const MODERATION_NOTICE_LIMIT = 50;

interface LogEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const tagOf = (tags: readonly string[][], name: string) => {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value !== "" ? value : null;
};

/** The reader's moderation notices, newest first. Entries `moderationItem` does not word are left out. */
export function buildModerationNotifications(
  events: readonly LogEvent[],
  viewer: string,
): NotificationItem[] {
  const seen = new Set<string>();
  const items: NotificationItem[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const item = moderationItem(e, viewer);
    if (item === null) continue;
    items.push({
      id: e.id,
      kind: "moderation",
      // The server signs the entry; who acted is in the board's public log.
      actor: e.pubkey,
      at: e.created_at,
      targetId: null,
      noteId: null,
      notice: {
        title: item.title,
        preview: item.preview,
        boardId: tagOf(e.tags, "h"),
        threadId: tagOf(e.tags, "thread"),
      },
    });
  }
  return items.sort((a, b) => b.at - a.at);
}
