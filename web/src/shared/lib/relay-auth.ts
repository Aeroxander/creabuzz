/**
 * Which identity the client presents to the relay when it authenticates.
 *
 * NIP-42 auth exists so the relay can authorize a *read* against who you are:
 * Buzz's relay refuses a p-gated filter (`kind:44100` member notifications, gift
 * wraps, DMs) whose `#p` does not equal the authenticated pubkey. Filters in this
 * app are built from the durable identity (`userPubkey()`), so authenticating as
 * anything else — a page-lifetime throwaway key — silently loses every mention
 * and membership notification while looking like a working connection.
 *
 * With no durable identity this stays on the anonymous page-lifetime key, which
 * is what keeps read-only browsing on open relays working without writing a key
 * to storage.
 */

import { existingUserPubkey, signAsUser } from "./identity.ts";
import {
  hasNip07Provider,
  signNostrEvent,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-signer.ts";

export async function signForRelay(
  template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
  options?: { requireNip07?: boolean; requireDurable?: boolean },
): Promise<SignedNostrEvent> {
  // Callers that require a browser extension mean it: their flows bind durable
  // state to that extension's key.
  if (options?.requireNip07) {
    return signNostrEvent(template, { requireNip07: true });
  }
  // Flows that create durable server-side state (relay membership, an invite
  // claim) must not be signed by the page-lifetime key: a reload would orphan
  // the row. Any identity that survives a reload will do — the stored nsec this
  // app creates for a browser user, a passkey, or an extension. Requiring the
  // extension specifically locked out browser readers.
  if (options?.requireDurable) {
    const durable = existingUserPubkey() !== null || hasNip07Provider();
    if (!durable) {
      throw new Error(
        "Joining needs an identity that survives a reload. Create your identity here, or install a Nostr signer extension.",
      );
    }
  }
  // `existingUserPubkey` does not create anything: browsing without an identity
  // must not leave a key behind.
  return existingUserPubkey() ? signAsUser(template) : signNostrEvent(template);
}
