/**
 * Notification feed for the current user: mentions (p-tag matches on channel
 * messages), task assignments needing action, member-added events, and a
 * board moderator's action on them (their post or reply removed, a mute).
 * Mirrors the desktop's feed categories with the same mention convention.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  parseLaunchRecord,
  launchCoordinate,
} from "@/features/launchpad/models";
import { KIND_LAUNCH_RECORD, KIND_REACTION } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey } from "@/shared/lib/identity";
import { readSeen, SEEN_EVENT, writeSeen } from "@/shared/lib/seen-state";
import { TIMELINE_CONTENT_KINDS } from "@/features/channels/use-channel-messages";
import { useMutedSet } from "@/features/social/use-social-actions";

import { type BellView, bellState } from "./lib/bell-state";
import { type CheerLine, cheerLines } from "./lib/cheer-lines";
import {
  KIND_BOARD_MODERATION_LOG,
  moderationItem,
} from "./lib/moderation-items";

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * When this account last looked at its notifications on this server, in milliseconds (the items here are dated in
 * them). It is the same time the timeline's bell keeps (`seen-state.ts`): looking at either marks both.
 */
function seenMs(me: string | null): number {
  return me ? readSeen(storage(), relayWsUrl(), me) * 1000 : 0;
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
  /** Whether the list is still being read, failed with nothing read, is empty, or has items. */
  view: BellView;
  /** The last poll failed; `items` are what loaded before. */
  stale: boolean;
  /** Why the last poll failed, or null. */
  error: unknown;
  /** Poll again now. */
  retry: () => void;
} {
  const me = existingUserPubkey();
  const [lastSeen, setLastSeen] = useState<number>(() => seenMs(me));
  // Marked read anywhere on the page (or in another tab): every count follows.
  useEffect(() => {
    const sync = () => setLastSeen(seenMs(me));
    sync();
    window.addEventListener(SEEN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SEEN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [me]);

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
    // Kept where the browser allows; either way the counts drop for this visit.
    if (me) writeSeen(storage(), relayWsUrl(), me, Math.ceil(now / 1000));
    setLastSeen(now);
    window.dispatchEvent(new Event(SEEN_EVENT));
  }, [me]);

  const { view, stale } = bellState({
    data: feed.data === undefined ? undefined : shown,
    error: feed.error,
    isLoading: feed.isLoading,
  });
  const { refetch } = feed;
  const retry = useCallback(() => void refetch(), [refetch]);

  return {
    items: shown,
    unread,
    markRead,
    lastSeen,
    view,
    stale,
    error: feed.error ?? null,
    retry,
  };
}

/** Cheers are read for today and yesterday; a cheer older than that is no longer news. */
const CHEER_READ_DAYS = 3;
const CHEER_READ = 100;
/** The most projects a cheer line looks up the name of. */
const CHEER_PROJECTS = 20;

/**
 * The founder's cheer lines: one per project and day ("3 people cheered Nebula today."), from the cheers other people
 * signed on the reader's records (`lib/cheer-lines.ts`). Read every minute while Home is open. A read that fails shows
 * no line: a cheer is a kindness, never something the reader is waiting on, so nothing is said about the failure.
 */
export function useCheerLines(): { lines: CheerLine[] } {
  const me = existingUserPubkey();
  const url = relayWsUrl();
  const muted = useMutedSet();
  const read = useQuery({
    queryKey: ["notifications", "cheers", url, me],
    enabled: me !== null,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      const person = me ?? "";
      const now = Math.floor(Date.now() / 1000);
      const reactions = await queryEvents(url, {
        kinds: [KIND_REACTION],
        "#p": [person],
        "#k": ["47003"],
        since: now - CHEER_READ_DAYS * 86_400,
        limit: CHEER_READ,
      });
      // The names of the projects those cheers are about: one read, by the accounts that started them.
      const coordinates = new Set(
        reactions.flatMap((e) => e.tags.find((t) => t[0] === "a")?.[1] ?? []),
      );
      const authors = [...new Set([...coordinates].map((c) => c.split(":")[1]))]
        .filter((a): a is string => /^[0-9a-f]{64}$/.test(a ?? ""))
        .slice(0, CHEER_PROJECTS);
      const names = new Map<string, string>();
      if (authors.length > 0) {
        const records = await queryEvents(url, {
          kinds: [KIND_LAUNCH_RECORD],
          authors,
          limit: 100,
        });
        for (const event of records) {
          const record = parseLaunchRecord(event);
          if (record)
            names.set(launchCoordinate(event.pubkey, record.id), record.name);
        }
      }
      return { reactions, names, now };
    },
  });
  const lines = useMemo(
    () =>
      me && read.data
        ? cheerLines({
            reactions: read.data.reactions,
            me,
            // The clock now, not the read's: a line from yesterday must not stay "today" past midnight.
            now: Math.floor(Date.now() / 1000),
            names: read.data.names,
            muted,
          })
        : [],
    [me, read.data, muted],
  );
  return { lines };
}
