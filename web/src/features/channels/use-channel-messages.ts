import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { subscribeChannel, type SubscriptionStatus } from "./subscribe-channel";

/**
 * Message kinds for the channel timeline (mirrors
 * `CHANNEL_TIMELINE_CONTENT_KINDS` in the desktop client).
 */
export const TIMELINE_CONTENT_KINDS = [
  9, 40002, 40008, 40099, 43001, 43002, 43003, 43004, 43005, 43006, 48100,
];

const AUX_KINDS = [7, 40003, 5, 9005]; // reactions, edits, deletions

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** Events keyed by id, newest-first list for ordering. */
export interface ChannelMessages {
  byId: Map<string, NostrEvent>;
  ordered: NostrEvent[];
}

async function fetchHistory(
  channelId: string,
  limit = 60,
): Promise<NostrEvent[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: TIMELINE_CONTENT_KINDS,
    "#h": [channelId],
    limit,
  });
  return events.sort((a, b) => a.created_at - b.created_at);
}

async function fetchAux(messageIds: string[]): Promise<NostrEvent[]> {
  if (messageIds.length === 0) return [];
  const events = await queryEvents(relayWsUrl(), {
    kinds: AUX_KINDS,
    "#e": messageIds.slice(0, 100),
    limit: 200,
  });
  return events;
}

/**
 * Timeline for one channel: one-shot history + live subscription merged into
 * a monotonic event list keyed by id. Live events arrive via the relay
 * subscription; a reload refetches history, so the list is complete within a
 * page session.
 */
export function useChannelMessages(channelId: string | null) {
  const [liveEvents, setLiveEvents] = useState<Map<string, NostrEvent>>(
    () => new Map(),
  );
  /** Transport state of this channel's live subscription. */
  const [liveStatus, setLiveStatus] = useState<SubscriptionStatus | null>(null);
  const enabled = channelId != null;
  const historyQuery = useQuery({
    queryKey: ["channel-history", channelId],
    queryFn: () => fetchHistory(channelId ?? ""),
    enabled,
    staleTime: 30_000,
  });
  // Live subscription (one socket per channel).
  useEffect(() => {
    if (!channelId) return;
    const unsubscribe = subscribeChannel(
      relayWsUrl(),
      {
        kinds: [...TIMELINE_CONTENT_KINDS, ...AUX_KINDS],
        "#h": [channelId],
        limit: 50,
      },
      {
        onEvent: (event) => {
          setLiveEvents((prev) => {
            const next = new Map(prev);
            next.set(event.id, event);
            return next;
          });
        },
        onStatus: setLiveStatus,
      },
    );
    return unsubscribe;
  }, [channelId]);

  const allEvents = useMemo(() => {
    const byId = new Map<string, NostrEvent>();
    const events = [...(historyQuery.data ?? []), ...liveEvents.values()];
    for (const event of events) {
      byId.set(event.id, event);
    }
    const ordered = [...byId.values()].sort(
      (a, b) => a.created_at - b.created_at,
    );
    return { byId, ordered };
  }, [historyQuery.data, liveEvents]);

  // One-shot aux backfill for history messages (edits/reactions/deletions).
  const historyIds = useMemo(
    () => (historyQuery.data ?? []).map((e) => e.id),
    [historyQuery.data],
  );
  const auxQuery = useQuery({
    queryKey: ["channel-aux", channelId, historyIds.join(",").slice(0, 400)],
    queryFn: () => fetchAux(historyIds),
    enabled: enabled && historyIds.length > 0,
    staleTime: 60_000,
  });

  const merged = useMemo(() => {
    const byId = new Map(allEvents.byId);
    for (const event of auxQuery.data ?? []) {
      byId.set(event.id, event);
    }
    const ordered = [...byId.values()].sort(
      (a, b) => a.created_at - b.created_at,
    );
    return { byId, ordered };
  }, [allEvents, auxQuery.data]);

  return {
    ...merged,
    isLoading: historyQuery.isLoading,
    error: historyQuery.error,
    /** Retry the history query after a failure. */
    refetch: historyQuery.refetch,
    /** `open` once the live socket is up; null before the first attempt. */
    liveStatus,
  };
}

/** Reply-chain grouping for rendering: parent id → children (non-root events). */
export function useThreadGroups(
  messages: ChannelMessages,
): Map<string, NostrEvent[]> {
  return useMemo(() => {
    const groups = new Map<string, NostrEvent[]>();
    const rootIds = new Set<string>();
    for (const event of messages.ordered) {
      const root = getTag(event, "e");
      if (root) rootIds.add(root);
    }
    for (const event of messages.ordered) {
      const root = getTag(event, "e");
      if (root && rootIds.has(root)) {
        const list = groups.get(root) ?? [];
        list.push(event);
        groups.set(root, list);
      } else if (!root) {
        const list = groups.get(event.id) ?? [];
        groups.set(event.id, list);
      }
    }
    return groups;
  }, [messages]);
}
