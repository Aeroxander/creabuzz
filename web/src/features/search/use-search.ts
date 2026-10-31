import { useQuery } from "@tanstack/react-query";

import { queryEventsHttp } from "@/shared/lib/http-query";
import type { NostrEvent, NostrFilter } from "@/shared/lib/nostr-client";
import { getTag } from "@/shared/lib/event-fields";

import { COMMUNITY_SEARCH_KINDS, ROOM_SEARCH_KINDS } from "./lib/search-hits";

/**
 * Full-text search over the current community's rooms and boards (chat, board
 * posts and replies), its wiki and its work, via the signed HTTP bridge.
 */
export function useSearch(term: string, channelIds: string[]) {
  return useQuery({
    queryKey: ["search", term, [...channelIds].sort().join(",")],
    queryFn: async () => {
      // Two filters, deliberately: the relay's scoping invariant walls
      // channel-scoped and community-global events off from each other, so a
      // single `#h`-scoped filter can never return a wiki page.
      const filters: NostrFilter[] = [
        channelIds.length > 0
          ? {
              kinds: ROOM_SEARCH_KINDS,
              "#h": channelIds,
              search: term,
              limit: 25,
            }
          : { kinds: ROOM_SEARCH_KINDS, search: term, limit: 25 },
        { kinds: COMMUNITY_SEARCH_KINDS, search: term, limit: 25 },
      ];
      const results = await queryEventsHttp(filters);
      // The same event can match both filters: key by id, newest first.
      const byId = new Map(results.map((event) => [event.id, event]));
      return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
    },
    enabled: term.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function eventChannelId(event: NostrEvent): string | undefined {
  return getTag(event, "h");
}
