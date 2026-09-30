/**
 * Durable browser identity for writes.
 *
 * Read-only browsing works with an anonymous page-lifetime key. Posting,
 * reacting, and joining need a key that survives reloads so messages stay
 * attributed to the same person. The key is stored NIP-49-encrypted in
 * localStorage with export/import; NIP-07 passthrough is attempted first
 * when available.
 */

import {
  decrypt as nip49Decrypt,
  encrypt as nip49Encrypt,
} from "nostr-tools/nip49";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  hasNip07Provider,
  getUserPubkeyOverride,
  getUserSignerOverride,
  getUserSigningBlockedReason,
  SigningBlockedError,
  type UnsignedNostrEvent,
  type SignedNostrEvent,
} from "./nostr-signer.ts";

/**
 * The stored account key. Since the NIP-49 migration this value is the
 * encrypted `ncryptsec1…` form, never plaintext; legacy 64-hex values are
 * migrated in place on first read. Presence checks against this key still
 * mean "an identity exists here".
 */
const IDENTITY_STORAGE_KEY = "buzz.identity.nsec";

/**
 * The NIP-49 wrapping password for `IDENTITY_STORAGE_KEY` (hex). Generated
 * once per browser. Honest posture: it sits in the same localStorage, so this
 * protects the account key from casual plaintext exposure and from either key
 * alone leaking — not from same-origin script access, which can read both.
 */
const IDENTITY_WRAP_KEY = "buzz.identity.wrap";

/** In-memory copy of the decrypted secret so signing never re-runs scrypt. */
let cachedSecretHex: string | null = null;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Encrypt and persist the account key; creates the wrap key when missing. */
function writeEncryptedIdentity(hex: string): void {
  try {
    let wrap = window.localStorage.getItem(IDENTITY_WRAP_KEY);
    if (!wrap) {
      wrap = bytesToHex(generateSecretKey());
      window.localStorage.setItem(IDENTITY_WRAP_KEY, wrap);
    }
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      String(nip49Encrypt(nsecToBytes(hex), wrap)),
    );
  } catch {
    // storage unavailable — the in-memory copy keeps this session working
  }
}

/**
 * The stored account secret key (hex), decrypting the NIP-49 form. A legacy
 * plaintext value is re-encrypted on this first read — one atomic overwrite
 * to the encrypted form, same logical identity. Returns null when nothing is
 * stored (it never creates an identity).
 */
export function storedIdentityHex(): string | null {
  if (cachedSecretHex) return cachedSecretHex;
  try {
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      const hex = raw.toLowerCase();
      writeEncryptedIdentity(hex);
      cachedSecretHex = hex;
      return hex;
    }
    if (raw.startsWith("ncryptsec1")) {
      const wrap = window.localStorage.getItem(IDENTITY_WRAP_KEY);
      if (!wrap) return null;
      const hex = bytesToHex(nip49Decrypt(raw, wrap));
      cachedSecretHex = hex;
      return hex;
    }
  } catch {
    // ignore — treat as unstored
  }
  return null;
}

/** Drop the in-memory decrypted key (sign-out, reset, tests). */
export function resetIdentitySecretCache(): void {
  cachedSecretHex = null;
}

/** Sign a template with the durable identity (NIP-07 first, stored nsec second). */
export async function signAsUser(
  template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  // Active signer override (e.g. PRF passkey) takes precedence.
  const override = getUserSignerOverride();
  if (override) {
    const signed = await override(unsigned);
    if (signed) return signed;
  }
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (provider) {
    const expectedPubkey = await provider.getPublicKey();
    const signed = await provider.signEvent(unsigned);
    if (signed.pubkey === expectedPubkey && signed.id && signed.sig) {
      return signed;
    }
  }
  // A registered passkey is who this reader is. Signing as something else —
  // including the key the next line would create — is how the app ends up
  // filtering by one identity and posting as another.
  const blocked = getUserSigningBlockedReason();
  if (blocked) throw new SigningBlockedError(blocked);
  const nsec = getOrCreateIdentity();
  const secretKey = nsecToBytes(nsec);
  const signed = finalizeEvent(unsigned, secretKey);
  return signed;
}

/**
 * Public key of the identity the app presents.
 *
 * A passkey identity wins over the stored nsec: it is what signatures carry, so
 * it is also what filters, own-message checks and "assigned to me" must compare
 * against. Without this the app asked the relay for `#p` of one identity while
 * authenticating and signing as another, and every p-gated read came back
 * refused.
 */
export function userPubkey(): string {
  const override = getUserPubkeyOverride()?.() ?? null;
  if (override) return override;
  return getPublicKey(nsecToBytes(getOrCreateIdentity()));
}

/** Current pubkey WITHOUT creating an identity (null when none stored). */
export function existingUserPubkey(): string | null {
  // The passkey identity counts even before it is unlocked this session: it is
  // who the reader is, and treating it as absent mints a second, stray nsec.
  const override = getUserPubkeyOverride()?.() ?? null;
  if (override) return override;
  try {
    const stored = storedIdentityHex();
    if (stored) {
      return getPublicKey(nsecToBytes(stored));
    }
  } catch {
    // ignore
  }
  return null;
}

/** Create or load the stored identity; returns the hex nsec. */
export function getOrCreateIdentity(): string {
  const existing = storedIdentityHex();
  if (existing) return existing;
  const hex = bytesToHex(generateSecretKey());
  writeEncryptedIdentity(hex);
  cachedSecretHex = hex;
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
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    return (
      raw != null &&
      (/^[0-9a-fA-F]{64}$/.test(raw) || raw.startsWith("ncryptsec1"))
    );
  } catch {
    return false;
  }
}

/** Replace the stored identity with an imported hex nsec. */
export function importIdentity(hex: string): string {
  const normalized = hex.trim().toLowerCase();
  const pubkey = getPublicKey(nsecToBytes(normalized));
  writeEncryptedIdentity(normalized);
  cachedSecretHex = normalized;
  return pubkey;
}

/** Remove the stored identity (and its wrap key) and replace it with a fresh one. */
export function rotateIdentity(): string {
  resetIdentitySecretCache();
  window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
  window.localStorage.removeItem(IDENTITY_WRAP_KEY);
  return userPubkey();
}

export { hasNip07Provider };
