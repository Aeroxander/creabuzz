/**
 * Community wiki pages — the read path.
 *
 * One bounded, kinds-explicit relay query fetches both wiki kinds plus
 * tombstones (kind:5) so deleted human pages disappear here as well:
 *
 * - kind:44001 human wiki pages (`d` = slug),
 * - kind:44002 agent wiki standups (`d` = `<space>/<slug>`, read-side LWW).
 *
 * Both kinds are community-level/global-only — the filter deliberately carries
 * no `h` tag (docs/agent-wiki.md). The desktop surface is read-only for now:
 * the live-collab editing surface (Yjs/Trystero) stays web-only.
 */
import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_AGENT_WIKI_PAGE,
  KIND_DELETION,
  KIND_WIKI_PAGE,
} from "@/shared/constants/kinds";

import { buildWikiPages, type WikiPage } from "./lib/pageIndex";

export const wikiQueryKey = ["wiki", "pages"] as const;

/** Bounded read: the wiki fetch never pulls more than this many events. */
export const WIKI_FETCH_LIMIT = 200;

const WIKI_STALE_TIME_MS = 30_000;
const WIKI_GC_TIME_MS = 5 * 60_000;

/** Fetch both wiki kinds + tombstones and fold them into the current pages. */
export async function fetchWikiPages(): Promise<WikiPage[]> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_WIKI_PAGE, KIND_DELETION, KIND_AGENT_WIKI_PAGE],
    limit: WIKI_FETCH_LIMIT,
  });
  return buildWikiPages(events);
}

/** All wiki page heads (human + agent), read-only. */
export function useWikiPages(enabled = true) {
  return useQuery({
    queryKey: wikiQueryKey,
    queryFn: fetchWikiPages,
    staleTime: WIKI_STALE_TIME_MS,
    gcTime: WIKI_GC_TIME_MS,
    enabled,
  });
}
