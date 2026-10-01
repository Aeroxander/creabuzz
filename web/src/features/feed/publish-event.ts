import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import {
  type SignedNostrEvent,
  type UnsignedNostrEvent,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

const PUBLISH_TIMEOUT_MS = 15_000;

/**
 * Sign with the user's NIP-07 extension and submit through the relay's
 * `POST /events` bridge (NIP-98 auth). Posting requires a real identity — an
 * ephemeral key would orphan the author on reload.
 */
export async function publishEvent(
  template: Omit<UnsignedNostrEvent, "created_at">,
): Promise<SignedNostrEvent> {
  const event = await signNostrEvent(template, { requireNip07: true });
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/events`;
  const body = JSON.stringify(event);
  const authorization = await makeNip98AuthHeader(url, "POST", {
    body,
    requireNip07: true,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || json.accepted === false) {
    const message =
      typeof json.message === "string"
        ? json.message
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return event;
}
