/**
 * Notification feed for the current user: mentions (p-tag matches on channel
 * messages), task assignments needing action, and member-added events.
 * Mirrors the desktop's feed categories with the same mention convention.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey } from "@/shared/lib/identity";
import { TIMELINE_CONTENT_KINDS } from "@/features/channels/use-channel-messages";

const SEEN_KEY = "buzz.notifications.seen";

/**
 * How often the feed is re-read.
 *
 * The relay does not fan out `#p` filters (docs/web-ui-roadmap.md §2), so a
 * live subscription would not deliver mentions; polling is what works. 15s
 * keeps a mention visible about as fast as the reader would notice, without a
 * request per tab per second.
 */
const POLL_MS = 15_000;

export interface NotificationItem {
  id: string;
  kind: "mention" | "task" | "member";
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
   * fanned out by the relay (see docs/web-ui-roadmap.md §2), so polling is the
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
    ])
      .then(([mentions, tasks, members]) => {
        const out: NotificationItem[] = [];
        for (const e of mentions) {
          out.push({
            id: e.id,
            kind: "mention",
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

  const unread = useMemo(
    () => items.filter((i) => i.at > lastSeen).length,
    [items, lastSeen],
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

  return { items, unread, markRead, lastSeen };
}
