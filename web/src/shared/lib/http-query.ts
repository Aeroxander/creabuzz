/**
 * HTTP bridge reads (POST /query) with NIP-98 auth.
 *
 * The WS client is enough for channel timelines; search (NIP-50) and other
 * bridge-only surfaces live here. NIP-98 signs each request with the same
 * identity pipeline as the WS writes, so HTTP reads see the same access
 * surface as the socket reads.
 */

import type { NostrFilter, NostrEvent } from "@/shared/lib/nostr-client";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayAnswered } from "./relay-failure.ts";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

export async function queryEventsHttp(
  filters: NostrFilter[],
): Promise<NostrEvent[]> {
  const url = `${relayHttpBaseUrl()}/query`;
  const body = JSON.stringify(filters);
  const auth = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body,
  });
  if (!response.ok) {
    let detail = `relay responded ${response.status}`;
    try {
      const json = (await response.json()) as { error?: string };
      if (json.error) detail = json.error;
    } catch {
      // non-JSON error body — keep status detail
    }
    // Tagged so a `missing Nostr auth` body classifies as auth-required and
    // every other body as an answered refusal — never as "did not answer".
    throw relayAnswered(detail);
  }
  return (await response.json()) as NostrEvent[];
}
