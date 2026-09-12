import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

/** A NIP-29 channel resolved from its kind:39000 metadata event. */
export interface Channel {
  /** Channel uuid (the `d` tag / h-tag used by timeline filters). */
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  /** Metadata timestamp, used as the cursor when walking older pages. */
  createdAt: number;
}

const KIND_CHANNEL_METADATA = 39000;

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** Deduplicate addressable events, keeping the latest per (pubkey, kind, d). */
function dedupLatest(events: NostrEvent[]): NostrEvent[] {
  const best = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = getTag(event, "d") ?? "";
    const key = `${event.pubkey}:${event.kind}:${d}`;
    const previous = best.get(key);
    if (!previous || event.created_at > previous.created_at) {
      best.set(key, event);
    }
  }
  return [...best.values()];
}

function eventToChannel(event: NostrEvent): Channel {
  const id = getTag(event, "d") ?? event.id;
  const name = getTag(event, "name") || id.slice(0, 8);
  const description = getTag(event, "about") ?? "";
  const isPrivate = event.tags.some((t) => t[0] === "private");
  return {
    id,
    name,
    description,
    visibility: isPrivate ? "private" : "public",
    createdAt: event.created_at,
  };
}

const CHANNEL_PAGE_SIZE = 200;

/**
 * One page of channel metadata, newest first from the relay's point of view.
 *
 * `until` walks back past the first page: a community with more channels than
 * one page would otherwise hide the older ones with no way to reach them.
 */
async function fetchChannels(until?: number): Promise<Channel[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_CHANNEL_METADATA],
    limit: CHANNEL_PAGE_SIZE,
    ...(until === undefined ? {} : { until }),
  });
  return dedupLatest(events)
    .map(eventToChannel)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Public channel list for the current community (kind:39000 metadata). */
export function useChannels() {
  const query = useQuery({
    queryKey: ["channels"],
    queryFn: () => fetchChannels(),
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  /** Pages walked back from the first one, plus how that walk is going. */
  const [olderChannels, setOlderChannels] = useState<Channel[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [exhausted, setExhausted] = useState(false);

  const channels = useMemo(() => {
    const byId = new Map<string, Channel>();
    for (const channel of [...(query.data ?? []), ...olderChannels]) {
      byId.set(channel.id, channel);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [query.data, olderChannels]);

  const oldestLoadedAt = useMemo(() => {
    const times = [...(query.data ?? []), ...olderChannels].map(
      (channel) => channel.createdAt,
    );
    return times.length > 0 ? Math.min(...times) : null;
  }, [query.data, olderChannels]);

  /**
   * Walk one page further back. Bounded by the relay: each call asks for
   * metadata at or before the oldest channel shown, and a short page ends the
   * walk.
   */
  const loadMoreChannels = useCallback(async () => {
    if (loadingMore || oldestLoadedAt === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchChannels(oldestLoadedAt);
      const known = new Set([
        ...(query.data ?? []).map((channel) => channel.id),
        ...olderChannels.map((channel) => channel.id),
      ]);
      setOlderChannels((previous) => [...previous, ...page]);
      if (page.length < CHANNEL_PAGE_SIZE) setExhausted(true);
      if (page.every((channel) => known.has(channel.id))) setExhausted(true);
    } catch (error) {
      // Surfaced in the sidebar: silently showing fewer channels reads as "this
      // community has no more".
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, oldestLoadedAt, olderChannels, query.data]);

  return {
    ...query,
    channels,
    loadingMore,
    moreError,
    hasMoreChannels:
      (query.data?.length ?? 0) >= CHANNEL_PAGE_SIZE && !exhausted,
    loadMoreChannels,
  };
}
