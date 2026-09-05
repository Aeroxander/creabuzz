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
  };
}

async function fetchChannels(): Promise<Channel[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_CHANNEL_METADATA],
    limit: 200,
  });
  return dedupLatest(events)
    .map(eventToChannel)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Public channel list for the current community (kind:39000 metadata). */
export function useChannels() {
  return useQuery({
    queryKey: ["channels"],
    queryFn: fetchChannels,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}
