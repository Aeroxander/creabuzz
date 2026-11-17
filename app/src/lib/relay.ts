/**
 * Reads and writes against the server the app is connected to, as the person using it. The relay client, the signer
 * and the refusal wording are the shared ones in `@creaton/core` (the same code web/ runs).
 */
import { signAsUser } from "@creaton/core/client/identity.ts";
import {
  type NostrEvent,
  type NostrFilter,
  queryEvents,
  queryEventsMulti,
} from "@creaton/core/client/nostr-client.ts";
import type { SignedNostrEvent } from "@creaton/core/client/nostr-signer.ts";
import { publishEvent } from "@creaton/core/client/publish-event.ts";
import { refusalText } from "@creaton/core/client/refusal-text.ts";
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";

export type { NostrEvent, NostrFilter };

/** One read. */
export function read(filter: NostrFilter): Promise<NostrEvent[]> {
  return queryEvents(relayWsUrl(), filter);
}

/** Several reads on one connection, one list per filter in the order asked. */
export function readMulti(
  filters: readonly NostrFilter[],
): Promise<NostrEvent[][]> {
  return queryEventsMulti(relayWsUrl(), filters);
}

/** The newest record of `kind` by `author`, or null. */
export async function readLatest(
  kind: number,
  author: string,
  tags: Record<string, string[]> = {},
): Promise<NostrEvent | null> {
  const filter: NostrFilter = { kinds: [kind], authors: [author], limit: 5 };
  for (const [name, values] of Object.entries(tags))
    filter[`#${name}`] = values;
  const events = await read(filter);
  return newestFirst(events)[0] ?? null;
}

/** Newest first, ties broken by id so the order never flickers. */
export function newestFirst<T extends { id: string; created_at: number }>(
  events: readonly T[],
): T[] {
  return [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
  );
}

/**
 * Sign `template` as the person, send it, and throw when the server refuses it: the server's own reason when it gave
 * one, otherwise `failure`. Every send is stopped first while changed terms are not agreed to (`publishEvent`).
 */
export async function publishAsUser(
  template: Parameters<typeof signAsUser>[0],
  failure: string,
): Promise<SignedNostrEvent> {
  const signed = await signAsUser(template);
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) throw new Error(refusalText(result.message, failure));
  return signed;
}
