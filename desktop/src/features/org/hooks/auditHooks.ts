import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { KIND_AUDIT_ENTRY } from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

import { AUDIT_EVENT_KINDS, AUDIT_FETCH_LIMIT } from "../lib/audit";
import { parseChainEntryBatch, type AuditChainEntry } from "../lib/auditChain";
import { ORG_STALE_TIME_MS, ORG_GC_TIME_MS, orgQueryKey } from "./shared";

// ── Audit log (the evidence spine) ────────────────────────────────────────

/**
 * One page of structural org events (kinds 37010–37014 + 46010/46030/46031).
 * The event stream IS the evidence — every structural change is a signed,
 * community-level event on the relay, and every revision is kept (no LWW
 * folding): an audit view shows history, not the current head.
 *
 * The chain is append-only, so older history is reached by walking the relay's
 * composite `(until, before_id)` cursor: `until` bounds the timestamp and
 * `before_id` breaks ties inside a dense second, which is exactly the relay's
 * `created_at DESC, id ASC` scan order. Each page is bounded by
 * AUDIT_FETCH_LIMIT and pages are deduplicated in the view.
 */
async function fetchAuditPage(
  cursor?: AuditPageCursor,
): Promise<{ events: RelayEvent[]; nextCursor?: AuditPageCursor }> {
  const events = await relayClient.fetchEvents({
    kinds: [...AUDIT_EVENT_KINDS],
    limit: AUDIT_FETCH_LIMIT,
    ...(cursor ? { until: cursor.until, before_id: cursor.beforeId } : {}),
  });
  // Relay scan order: newest first, id ascending inside a tied second.
  const sorted = [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
  const oldest = sorted.at(-1);
  const nextCursor =
    sorted.length >= AUDIT_FETCH_LIMIT && oldest
      ? { until: oldest.created_at, beforeId: oldest.id }
      : undefined;
  return { events: sorted, nextCursor };
}

/** Keyset cursor for the next older audit page. */
export type AuditPageCursor = { until: number; beforeId: string };

export function useOrgAuditQuery(enabled = true) {
  return useInfiniteQuery({
    queryKey: [...orgQueryKey, "audit"],
    queryFn: ({ pageParam }) => fetchAuditPage(pageParam),
    initialPageParam: undefined as AuditPageCursor | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Hash-chain entries (kind:48001) ─────────────────────────────────────────

/**
 * The relay's hash-chain entries, published (relay-signed) as
 * `KIND_AUDIT_ENTRY` events and verified client-side by `lib/auditChain.ts`.
 *
 * Honest expectation: the relay serves these to community owners and admins
 * only, so for anyone else — or on a relay that predates the publisher — this
 * returns an empty set, and the view says so instead of claiming verification
 * it did not perform. Explicit kinds (relay p-gate) and a bounded limit.
 */
async function fetchAuditChain(): Promise<OrgAuditChainPage> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_AUDIT_ENTRY],
    limit: AUDIT_CHAIN_FETCH_LIMIT,
  });
  const { entries, malformed } = parseChainEntryBatch(
    events.map((event) => event.content),
  );
  entries.sort((a, b) => a.seq - b.seq);
  return {
    entries,
    malformed,
    hitLimit: events.length >= AUDIT_CHAIN_FETCH_LIMIT,
  };
}

/** Bounded read of the chain: never more than this many entries per page. */
export const AUDIT_CHAIN_FETCH_LIMIT = 200;

export type OrgAuditChainPage = {
  /** Entries parsed from kind:48001 envelopes, ascending by seq. */
  entries: AuditChainEntry[];
  /** Envelopes that did not parse — reported, never silently dropped. */
  malformed: number;
  /** The fetch hit its bound: older chain history exists beyond it. */
  hitLimit: boolean;
};

export function useOrgAuditChainQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "audit-chain"],
    queryFn: fetchAuditChain,
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}
