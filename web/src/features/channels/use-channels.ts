import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type Channel,
  channelsFromRecords,
  listedRooms,
} from "./lib/channel-records";

export type { Channel } from "./lib/channel-records";

const KIND_CHANNEL_METADATA = 39000;

const CHANNEL_PAGE_SIZE = 200;

/**
 * One page of channel metadata, newest first from the relay's point of view.
 * DM threads stay in the page (the walk back pages by record); `useChannels`
 * leaves them out of what it lists.
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
  return channelsFromRecords(events);
}

/**
 * The rooms of the current community (kind:39000 metadata). Direct-message
 * threads are left out of `channels` and `data` alike: Messages lists them.
 */
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
    return listedRooms([...byId.values()]).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [query.data, olderChannels]);

  const firstPageRooms = useMemo(
    () => (query.data === undefined ? undefined : listedRooms(query.data)),
    [query.data],
  );

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
    data: firstPageRooms,
    channels,
    loadingMore,
    moreError,
    hasMoreChannels:
      (query.data?.length ?? 0) >= CHANNEL_PAGE_SIZE && !exhausted,
    loadMoreChannels,
  };
}
