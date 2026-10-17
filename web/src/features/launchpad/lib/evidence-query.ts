/**
 * Where a launch's evidence is fetched from.
 *
 * The directory read is bounded (the newest 500 events of every kind), so on a busy server an old claim's evidence falls
 * out of it while it is still stored, and a reviewer loses the Approve button for a claim that is waiting on them. The
 * evidence is therefore read for the launch on its own: only its updates, whatever else the server holds.
 *
 * Pure and alias-free: `evidence-query.test.mjs` drives it under `node --test`.
 */

import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";
import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";

/** Bounded read size for one launch's updates: far more than a launch has claims. */
export const EVIDENCE_QUERY_LIMIT = 500;

/** The filter for a launch's updates, by the launch coordinate every one of them names in its `a` tag. */
export function evidenceQueryFilter(launchCoordinate: string): NostrFilter {
  return {
    kinds: [KIND_LAUNCH_UPDATE],
    "#a": [launchCoordinate],
    limit: EVIDENCE_QUERY_LIMIT,
  };
}
