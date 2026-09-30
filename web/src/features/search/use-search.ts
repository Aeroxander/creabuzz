import {
  KIND_AGENT_TASK,
  KIND_GIT_ISSUE,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  KIND_WIKI_PAGE,
} from "@/shared/constants/kinds";
import { useQuery } from "@tanstack/react-query";

import { queryEventsHttp } from "@/shared/lib/http-query";
import type { NostrEvent, NostrFilter } from "@/shared/lib/nostr-client";

/**
 * What search looks at.
 *
 * Channel conversation first, then the knowledge surfaces: wiki pages
 * (`44001`) and work items (`44011`) live in the community scope, so a search
 * that only runs the channel-scoped filter never sees them — which is why
 * finding a decision meant remembering where it was discussed.
 */
const SEARCH_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_WIKI_PAGE,
  KIND_AGENT_TASK,
  KIND_GIT_ISSUE,
];

/**
 * NIP-50 full-text search over the accessible channels of the current
 * community, via the signed HTTP bridge.
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
          ? { kinds: SEARCH_KINDS, "#h": channelIds, search: term, limit: 25 }
          : { kinds: SEARCH_KINDS, search: term, limit: 25 },
        { kinds: [44001, 44011, 1621], search: term, limit: 25 },
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

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

export function eventChannelId(event: NostrEvent): string | undefined {
  return getTag(event, "h");
}

export function eventText(event: NostrEvent): string {
  return typeof event.content === "string" ? event.content : "";
}
