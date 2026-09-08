/**
 * Durable browser identity for writes.
 *
 * Read-only browsing works with an anonymous page-lifetime key. Posting,
 * reacting, and joining need a key that survives reloads so messages stay
 * attributed to the same person. v1 stores an nsec in localStorage with
 * export/import; NIP-07 passthrough is attempted first when available.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  hasNip07Provider,
  type UnsignedNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";

const IDENTITY_STORAGE_KEY = "buzz.identity.nsec";

/** Sign a template with the durable identity (NIP-07 first, stored nsec second). */
export async function signAsUser(
  template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (provider) {
    const expectedPubkey = await provider.getPublicKey();
    const signed = await provider.signEvent(unsigned);
    if (signed.pubkey === expectedPubkey && signed.id && signed.sig) {
      return signed;
    }
  }
  const nsec = getOrCreateIdentity();
  const secretKey = nsecToBytes(nsec);
  const signed = finalizeEvent(unsigned, secretKey);
  return signed;
}

/** Public key of the durable identity (creating it if needed). */
export function userPubkey(): string {
  return getPublicKey(nsecToBytes(getOrCreateIdentity()));
}

/** Create or load the stored identity; returns the hex nsec. */
export function getOrCreateIdentity(): string {
  try {
    const existing = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (existing && existing.length === 64) return existing;
  } catch {
    // storage unavailable — fall through to create (will throw on store)
  }
  const secretKey = generateSecretKey();
  const hex = Array.from(secretKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  window.localStorage.setItem(IDENTITY_STORAGE_KEY, hex);
  return hex;
}

/** nsec hex string → bytes. */
export function nsecToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Identity is not a valid 32-byte hex nsec");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** True when a durable identity already exists on this browser. */
export function hasStoredIdentity(): boolean {
  try {
    const existing = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    return existing != null && existing.length === 64;
  } catch {
    return false;
  }
}

/** Replace the stored identity with an imported hex nsec. */
export function importIdentity(hex: string): string {
  const pubkey = getPublicKey(nsecToBytes(hex.trim().toLowerCase()));
  window.localStorage.setItem(IDENTITY_STORAGE_KEY, hex.trim().toLowerCase());
  return pubkey;
}

/** Remove the stored identity and replace it with a fresh one. */
export function rotateIdentity(): string {
  window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
  return userPubkey();
}

export { hasNip07Provider };
