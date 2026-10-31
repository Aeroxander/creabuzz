/**
 * Notification feed for the current user: mentions (p-tag matches on channel
 * messages), task assignments needing action, member-added events, and a
 * board moderator's action on them (their post or reply removed, a mute).
 * Mirrors the desktop's feed categories with the same mention convention.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey } from "@/shared/lib/identity";
import { TIMELINE_CONTENT_KINDS } from "@/features/channels/use-channel-messages";
import { useMutedSet } from "@/features/social/use-social-actions";

import {
  KIND_BOARD_MODERATION_LOG,
  moderationItem,
} from "./lib/moderation-items";

const SEEN_KEY = "buzz.notifications.seen";
/** Said on this page when the feed is marked read, so every count of it (the bell, the main nav) drops together. */
const SEEN_EVENT = "buzz:notifications-seen";

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * How often the feed is re-read.
 *
 * The relay does not fan out `#p` filters (docs/archive/web-ui-roadmap.md §2), so a
 * live subscription would not deliver mentions; polling is what works. 15s
 * keeps a mention visible about as fast as the reader would notice, without a
 * request per tab per second.
 */
const POLL_MS = 15_000;
const NONE: NotificationItem[] = [];

export interface NotificationItem {
  id: string;
  kind: "mention" | "task" | "member" | "moderation";
  /** Who wrote it, for a mention: a person the reader muted is left out. */
  author?: string;
  title: string;
  preview: string;
  channelId: string | null;
  at: number;
}

/** The reader's notifications on this server, newest first. */
async function fetchNotifications(me: string): Promise<NotificationItem[]> {
  const [mentions, tasks, members, moderation] = await Promise.all([
    // Mentions: any channel message carrying a p-tag for me.
    queryEvents(relayWsUrl(), {
      kinds: TIMELINE_CONTENT_KINDS,
      "#p": [me],
      limit: 40,
    }),
    // Tasks assigned to me that still need attention.
    queryEvents(relayWsUrl(), {
      kinds: [44011],
      "#p": [me],
      limit: 40,
    }),
    // Relay-authored membership notifications.
    queryEvents(relayWsUrl(), { kinds: [44100], "#p": [me], limit: 20 }),
    // A board's public log entries about me (the server writes these).
    queryEvents(relayWsUrl(), {
      kinds: [KIND_BOARD_MODERATION_LOG],
      "#p": [me],
      limit: 20,
    }),
  ]);
  const out: NotificationItem[] = [];
  for (const e of mentions) {
    out.push({
      id: e.id,
      kind: "mention",
      author: e.pubkey.toLowerCase(),
      title: "Mentioned you",
      preview: e.content.slice(0, 120),
      channelId: e.tags.find((t) => t[0] === "h")?.[1] ?? null,
      at: e.created_at * 1000,
    });
  }
  for (const e of tasks) {
    const status = (() => {
      try {
        return (JSON.parse(e.content) as { status?: string }).status ?? "";
      } catch {
        return "";
      }
    })();
    if (!["assigned", "in_progress", "needs_approval"].includes(status)) {
      continue;
    }
    out.push({
      id: e.id,
      kind: "task",
      title: "Task assigned to you",
      preview:
        (() => {
          try {
            return (JSON.parse(e.content) as { title?: string }).title ?? "";
          } catch {
            return "";
          }
        })().slice(0, 120) || e.content.slice(0, 120),
      channelId: null,
      at: e.created_at * 1000,
    });
  }
  for (const e of members) {
    out.push({
      id: e.id,
      kind: "member",
      title: "Community event",
      preview: e.content.slice(0, 120),
      channelId: null,
      at: e.created_at * 1000,
    });
  }
  for (const e of moderation) {
    const item = moderationItem(e, me);
    if (item === null) continue;
    out.push({
      id: e.id,
      kind: "moderation",
      title: item.title,
      preview: item.preview.slice(0, 160),
      channelId: e.tags.find((t) => t[0] === "h")?.[1] ?? null,
      at: e.created_at * 1000,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 60);
}

export function useNotifications(): {
  items: NotificationItem[];
  unread: number;
  markRead: () => void;
  lastSeen: number;
} {
  const me = existingUserPubkey();
  const [lastSeen, setLastSeen] = useState<number>(readSeen);
  // Marked read anywhere on the page (or in another tab): every count follows.
  useEffect(() => {
    const sync = () => setLastSeen(readSeen());
    window.addEventListener(SEEN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SEEN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  /**
   * The feed, re-read every so often. The relay does not fan out `#p` filters (docs/archive/web-ui-roadmap.md §2), so
   * polling is the mechanism that works; a focus refresh covers a tab that was parked. One shared query: the bell and
   * the main nav's count read the same poll. A failed read keeps what was shown.
   */
  const url = relayWsUrl();
  const feed = useQuery({
    queryKey: ["notifications", url, me],
    queryFn: () => fetchNotifications(me ?? ""),
    enabled: me !== null,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const items = feed.data ?? NONE;

  // A mention from someone the reader muted is not shown or counted. A moderator's notice about the reader always is.
  const muted = useMutedSet();
  const shown = useMemo(
    () =>
      items.filter(
        (item) => item.author === undefined || !muted.has(item.author),
      ),
    [items, muted],
  );

  const unread = useMemo(
    () => shown.filter((i) => i.at > lastSeen).length,
    [shown, lastSeen],
  );

  const markRead = useCallback(() => {
    const now = Date.now();
    try {
      localStorage.setItem(SEEN_KEY, String(now));
    } catch {
      // ignore
    }
    setLastSeen(now);
    window.dispatchEvent(new Event(SEEN_EVENT));
  }, []);

  return { items: shown, unread, markRead, lastSeen };
}
