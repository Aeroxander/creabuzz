/**
 * The Discover page's single read: one bounded REQ over the explicit kind
 * list in `lib/directory.ts` `DISCOVER_EVENT_KINDS`, derived into the three
 * sections by a pure function.
 *
 * Deliberately its own query key rather than a reuse of `use-launches` /
 * `use-project-events`: the directory must be one *snapshot* — three
 * separately-refreshed queries can disagree with each other for as long as a
 * refetch is in flight, and this page prints counts across all three
 * sections. The cost is bounded (one REQ, 700 events, 60s stale).
 *
 * Failures surface as `error` for `QueryError` — never as three empty
 * sections, which would read as "this relay has nothing on it"
 * (Review-Proven Rule 1: no terminal failure rendered as an empty result).
 */
import { useQuery } from "@tanstack/react-query";

import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  DISCOVER_EVENT_KINDS,
  deriveDirectory,
  type DirectorySnapshot,
} from "./lib/directory";

export const discoverQueryKey = ["discover", "directory"] as const;

/** One page-worth of records; bounded on the relay and in the client. */
const DISCOVER_LIMIT = 700;

export async function fetchDiscoverEvents(): Promise<NostrEvent[]> {
  return queryEvents(relayWsUrl(), {
    kinds: [...DISCOVER_EVENT_KINDS],
    limit: DISCOVER_LIMIT,
  });
}

/** The directory snapshot: `{ daos, launches, projects, counts }`. */
export function useDiscover() {
  return useQuery<DirectorySnapshot>({
    queryKey: discoverQueryKey,
    queryFn: async () =>
      deriveDirectory({
        events: await fetchDiscoverEvents(),
        me: existingUserPubkey(),
      }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
