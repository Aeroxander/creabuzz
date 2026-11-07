import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { countSupporters } from "./lib/supporters";

/** NIP-51 bookmark list: where "follow this launch" is stored. */
const KIND_BOOKMARKS = 10003;
const MAX_LISTS = 1000;

/**
 * Supporter counts for the given launch coordinates, one read for all of them.
 * Empty until loaded: a count is shown only once known, never as a zero.
 */
export function useSupporters(coordinates: readonly string[]) {
  const key = [...coordinates].sort();
  return useQuery({
    queryKey: ["launchpad", "supporters", key],
    enabled: key.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_BOOKMARKS],
        "#a": key,
        limit: MAX_LISTS,
      });
      return countSupporters(events, key);
    },
  });
}
