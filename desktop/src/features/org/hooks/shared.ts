import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";

// ── Query keys ──────────────────────────────────────────────────────────────

export const orgQueryKey = ["org"] as const;

// ── Stale/GC times ─────────────────────────────────────────────────────────

export const ORG_STALE_TIME_MS = 60_000; // 1 minute
export const ORG_GC_TIME_MS = 5 * 60_000; // 5 minutes

// ── Fetch helpers ───────────────────────────────────────────────────────────

// NOTE: relayClient.fetchEvents(filter) does not accept an AbortSignal (the
// RelaySubscriptionFilter has no signal field), so React Query's cancellation
// signal cannot be forwarded yet. The parameter is kept so the call sites
// already match a future fetchEvents(filter, { signal }) upgrade.
export async function fetchOrgEvents(
  kinds: number[],
  _signal?: AbortSignal,
): Promise<RelayEvent[]> {
  return relayClient.fetchEvents({
    kinds,
    limit: 500,
  });
}

/** The newest record you signed for a coordinate — only its author can replace it. */
export async function fetchOwnRecord(
  kind: number,
  dtag: string,
  pubkey: string,
): Promise<RelayEvent | null> {
  const events = await relayClient.fetchEvents({
    kinds: [kind],
    authors: [pubkey],
    "#d": [dtag],
    limit: 20,
  });
  const own = events
    .filter(
      (e) =>
        e.pubkey.toLowerCase() === pubkey.toLowerCase() &&
        e.tags.some((t) => t[0] === "d" && t[1] === dtag),
    )
    .sort((a, b) => b.created_at - a.created_at);
  return own[0] ?? null;
}
