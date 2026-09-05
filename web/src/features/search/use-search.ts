import { useQuery } from "@tanstack/react-query";

import { queryEventsHttp } from "@/shared/lib/http-query";
import type { NostrEvent, NostrFilter } from "@/shared/lib/nostr-client";

const SEARCH_KINDS = [9, 40002, 40008, 40099];

/**
 * NIP-50 full-text search over the accessible channels of the current
 * community, via the signed HTTP bridge.
 */
export function useSearch(term: string, channelIds: string[]) {
  return useQuery({
    queryKey: ["search", term, [...channelIds].sort().join(",")],
    queryFn: async () => {
      const filter: NostrFilter =
        channelIds.length > 0
          ? { kinds: SEARCH_KINDS, "#h": channelIds, search: term, limit: 25 }
          : { kinds: SEARCH_KINDS, search: term, limit: 25 };
      const results = await queryEventsHttp([filter]);
      return results.sort((a, b) => b.created_at - a.created_at);
    },
    enabled: term.trim().length >= 2,
    staleTime: 30_000,
  });
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

export function eventChannelId(event: NostrEvent): string | undefined {
  return getTag(event, "h");
}

export function eventText(event: NostrEvent): string {
  return typeof event.content === "string" ? event.content : "";
}
