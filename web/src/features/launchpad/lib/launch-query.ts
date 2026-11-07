/**
 * The launchpad's directory query — one place to define its shape.
 *
 * The shape is the contract with the relay's gates: `kinds` must be explicit
 * (a filter without kinds trips the relay's p-gate) and `limit` must be
 * bounded (an unbounded REQ is a memory lever the reader controls). Kept as a
 * pure function so `launch-query.test.mjs` pins the shape and
 * `launchpadQueryContract.test.mjs` pins that `fetchLaunches` still uses it —
 * changing either alone fails a test.
 */

import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";
import { LAUNCHPAD_EVENT_KINDS } from "../../../shared/constants/kinds.ts";

/** Bounded read size for the directory (records + mirrors + score roots). */
export const LAUNCH_QUERY_LIMIT = 500;

export function launchQueryFilter(): NostrFilter {
  return {
    kinds: [...LAUNCHPAD_EVENT_KINDS],
    limit: LAUNCH_QUERY_LIMIT,
  };
}
