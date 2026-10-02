import {
  queryEvents,
  type NostrEvent,
  type NostrFilter,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

/** One relay read against the community relay. */
export function readEvents(filter: NostrFilter): Promise<NostrEvent[]> {
  return queryEvents(relayWsUrl(), filter);
}

/** The newest event of `kind` by `author`, or null. */
export async function readLatest(
  kind: number,
  author: string,
): Promise<NostrEvent | null> {
  const events = await readEvents({
    kinds: [kind],
    authors: [author],
    limit: 5,
  });
  return (
    [...events].sort(
      (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
    )[0] ?? null
  );
}
