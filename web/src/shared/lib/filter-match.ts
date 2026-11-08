/**
 * Whether a signed event satisfies a NIP-01 filter, for the parts of a filter this client sends: `ids`, `authors`,
 * `kinds`, `since`, `until` and `#x` tag lists. Pure and alias-free so `node --test` runs the code the browser runs.
 *
 * The server does the real matching; this only sorts the events of one multi-filter REQ back under the filter each
 * answers (`queryEventsMulti`). `limit` is the caller's to apply, and a `search` filter is never matched here.
 */

import type { NostrEvent, NostrFilter } from "./nostr-client.ts";

export function eventMatchesFilter(
  filter: NostrFilter,
  event: NostrEvent,
): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(wanted)) continue;
    const name = key.slice(1);
    const held = event.tags.some(
      (tag) => tag[0] === name && wanted.includes(tag[1]),
    );
    if (!held) return false;
  }
  return true;
}
