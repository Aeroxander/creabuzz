/**
 * HTTP bridge reads (POST /query) with NIP-98 auth.
 *
 * The WS client is enough for channel timelines; search (NIP-50) and other
 * bridge-only surfaces live here. NIP-98 signs each request with the same
 * identity pipeline as the WS writes, so HTTP reads see the same access
 * surface as the socket reads.
 *
 * Every read has a deadline (`timed-fetch.ts`): a server that never answers
 * ends as a `ServerTimeoutError`, which the failure table reads as "did not
 * answer", instead of a screen that waits forever.
 */

import type { NostrFilter, NostrEvent } from "@/shared/lib/nostr-client";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { queryReplyEvents } from "./query-reply.ts";
import { timedFetchBody } from "./timed-fetch.ts";

export interface HttpQueryOptions {
  /** The caller's signal: a superseded read stops quietly with the caller's reason. */
  signal?: AbortSignal;
  /** Deadline override, in milliseconds. */
  timeoutMs?: number;
}

export async function queryEventsHttp(
  filters: NostrFilter[],
  options: HttpQueryOptions = {},
): Promise<NostrEvent[]> {
  const url = `${relayHttpBaseUrl()}/query`;
  const body = JSON.stringify(filters);
  const auth = await makeNip98AuthHeader(url, "POST", { body });
  const reply = await timedFetchBody(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return queryReplyEvents(reply) as NostrEvent[];
}
