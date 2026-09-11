import { useCallback, useEffect, useMemo, useState } from "react";
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

const HISTORY_PAGE_SIZE = 60;

/**
 * One page of channel history, newest first from the relay's point of view.
 *
 * `until` asks for everything at or before that timestamp, which is how the
 * timeline walks backwards past its first page. The boundary event can come
 * back twice; callers key by event id.
 */
async function fetchHistory(
  channelId: string,
  limit = HISTORY_PAGE_SIZE,
  until?: number,
): Promise<NostrEvent[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: TIMELINE_CONTENT_KINDS,
    "#h": [channelId],
    limit,
    ...(until === undefined ? {} : { until }),
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
  /**
   * Pages fetched by walking backwards from the first page. Without this the
   * timeline can only ever show the newest page, so anything older than that is
   * unreachable.
   */
  const [olderEvents, setOlderEvents] = useState<Map<string, NostrEvent>>(
    () => new Map(),
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  /** False once a page came back short, or the first page was already short. */
  const [olderExhausted, setOlderExhausted] = useState(false);
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
    const events = [
      ...(historyQuery.data ?? []),
      ...olderEvents.values(),
      ...liveEvents.values(),
    ];
    for (const event of events) {
      byId.set(event.id, event);
    }
    const ordered = [...byId.values()].sort(
      (a, b) => a.created_at - b.created_at,
    );
    return { byId, ordered };
  }, [historyQuery.data, olderEvents, liveEvents]);

  const oldestLoadedAt = useMemo(() => {
    const times = [...(historyQuery.data ?? []), ...olderEvents.values()].map(
      (event) => event.created_at,
    );
    return times.length > 0 ? Math.min(...times) : null;
  }, [historyQuery.data, olderEvents]);

  /**
   * Walk one page further back. Bounded by the relay: each call asks for events
   * at or before the oldest one shown, and a short page ends the walk.
   */
  const loadOlder = useCallback(async () => {
    if (!channelId || loadingOlder) return;
    const until = oldestLoadedAt;
    if (until === null) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await fetchHistory(channelId, HISTORY_PAGE_SIZE, until);
      setOlderEvents((previous) => {
        const next = new Map(previous);
        for (const event of page) next.set(event.id, event);
        return next;
      });
      // A short page (or one that added nothing new beyond the boundary) is the
      // end of the channel's history.
      const added = page.filter((event) => !olderEvents.has(event.id)).length;
      if (page.length < HISTORY_PAGE_SIZE) setOlderExhausted(true);
      if (page.length === 0 || added === 0) setOlderExhausted(true);
    } catch (error) {
      // Surfaced in the timeline: silently showing nothing new would read as
      // "this is the beginning of the channel".
      setOlderError(error);
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, loadingOlder, oldestLoadedAt, olderEvents]);

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
    /** Whether older messages exist to fetch, once known. */
    hasOlder:
      (historyQuery.data?.length ?? 0) >= HISTORY_PAGE_SIZE && !olderExhausted,
    loadingOlder,
    olderError,
    /** Fetch one more page of older messages. */
    loadOlder,
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
