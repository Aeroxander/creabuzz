import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { KIND_AGENT_WIKI_PAGE } from "@/shared/constants/kinds";

import {
  AGENT_WIKI_FETCH_LIMIT,
  newestAgentWikiPages,
  type AgentWikiPage,
} from "../lib/agentWiki";
import { ORG_STALE_TIME_MS, ORG_GC_TIME_MS, orgQueryKey } from "./shared";

// ── Agent Wiki (kind:44002, read-only) ──────────────────────────────────────

async function fetchAgentWikiPages(
  _signal?: AbortSignal,
): Promise<AgentWikiPage[]> {
  // Bounded at the wiki's own limit, not fetchOrgEvents' 500-event cap.
  // fetchEvents does not take a signal yet (see the NOTE on fetchOrgEvents).
  const events = await relayClient.fetchEvents({
    kinds: [KIND_AGENT_WIKI_PAGE],
    limit: AGENT_WIKI_FETCH_LIMIT,
  });
  return newestAgentWikiPages(events);
}

/**
 * Fetch a single wiki page head by its full d tag ("default/standup").
 * Bounded and folded by the same read-side LWW as the list query.
 */
export async function fetchAgentWikiPage(
  d: string,
  _signal?: AbortSignal,
): Promise<AgentWikiPage | null> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_AGENT_WIKI_PAGE],
    "#d": [d],
    limit: AGENT_WIKI_FETCH_LIMIT,
  });
  return newestAgentWikiPages(events)[0] ?? null;
}

/** All wiki page heads, newest-first, folded per (pubkey, d) then per d. */
export function useAgentWikiPagesQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "agent-wiki"],
    queryFn: ({ signal }) => fetchAgentWikiPages(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}
