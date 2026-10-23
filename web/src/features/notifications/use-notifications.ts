/**
 * Notification feed for the current user: mentions (p-tag matches on channel
 * messages), task assignments needing action, member-added events, and a
 * board moderator's action on them (their post or reply removed, a mute).
 * Mirrors the desktop's feed categories with the same mention convention.
 */

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

/**
 * How often the feed is re-read.
 *
 * The relay does not fan out `#p` filters (docs/archive/web-ui-roadmap.md §2), so a
 * live subscription would not deliver mentions; polling is what works. 15s
 * keeps a mention visible about as fast as the reader would notice, without a
 * request per tab per second.
 */
const POLL_MS = 15_000;

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

export function useNotifications(): {
  items: NotificationItem[];
  unread: number;
  markRead: () => void;
  lastSeen: number;
} {
  const me = existingUserPubkey();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [lastSeen, setLastSeen] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(SEEN_KEY)) || 0;
    } catch {
      return 0;
    }
  });

  /**
   * Refresh the feed.
   *
   * This used to run exactly once, when the hook mounted: a mention that
   * arrived while the app was open never raised the badge, so the bell only
   * ever showed what had happened before the page loaded. `#p` filters are not
   * fanned out by the relay (see docs/archive/web-ui-roadmap.md §2), so polling is the
   * mechanism that works; a focus refresh covers a tab that was parked.
   */
  const refresh = useCallback(async () => {
    if (!me) return;
    await Promise.all([
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
    ])
      .then(([mentions, tasks, members, moderation]) => {
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
              return (
                (JSON.parse(e.content) as { status?: string }).status ?? ""
              );
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
                  return (
                    (JSON.parse(e.content) as { title?: string }).title ?? ""
                  );
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
        setItems(out.sort((a, b) => b.at - a.at).slice(0, 60));
      })
      .catch((error: unknown) => {
        console.warn("[notifications] refresh failed", error);
      });
  }, [me]);

  useEffect(() => {
    if (!me) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [me, refresh]);

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
  }, []);

  return { items: shown, unread, markRead, lastSeen };
}
