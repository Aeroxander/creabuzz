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
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
  getConversationKey,
} from "nostr-tools/nip44";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  hasNip07Provider,
  getUserNip44Override,
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

/**
 * A stored identity blob exists but cannot be read back (missing wrap key,
 * failed NIP-49 decrypt, or a value that is neither a valid legacy hex key nor
 * an `ncryptsec1` blob). This is a hard error, never "treat as unstored":
 * returning null here is exactly how a caller silently mints a brand-new key
 * and overwrites the user's real one. Callers surface this to the user with a
 * recovery path (reset / re-import) instead of regenerating.
 */
export class StoredIdentityUnreadableError extends Error {
  constructor() {
    super("Stored identity exists but cannot be read");
    this.name = "StoredIdentityUnreadableError";
  }
}

/** Read a storage key without throwing (storage may be unavailable). */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Encrypt and persist the account key; creates the wrap key when missing.
 * Write failures PROPAGATE (they used to be swallowed, which left a freshly
 * minted key living only in memory — gone on reload). Callers on the create /
 * import path must let the error surface so the user never believes a key was
 * saved when it was not.
 */
function writeEncryptedIdentity(hex: string): void {
  let wrap = readStorage(IDENTITY_WRAP_KEY);
  if (!wrap) {
    wrap = bytesToHex(generateSecretKey());
    window.localStorage.setItem(IDENTITY_WRAP_KEY, wrap);
  }
  window.localStorage.setItem(
    IDENTITY_STORAGE_KEY,
    String(nip49Encrypt(nsecToBytes(hex), wrap)),
  );
}

/**
 * The stored account secret key (hex), decrypting the NIP-49 form. A legacy
 * plaintext value is re-encrypted on this first read — one atomic overwrite
 * to the encrypted form, same logical identity (best-effort: the plaintext key
 * is still durable if that upgrade write fails, so this never turns a working
 * key into a dead end). Returns null ONLY when nothing is stored. When a blob
 * exists but cannot be decrypted it throws {@link StoredIdentityUnreadableError}
 * — it must never fall through to "unstored" and let a caller regenerate over
 * the user's identity.
 */
export function storedIdentityHex(): string | null {
  if (cachedSecretHex) return cachedSecretHex;
  const raw = readStorage(IDENTITY_STORAGE_KEY);
  if (!raw) return null;
  let hex: string;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    hex = raw.toLowerCase();
    try {
      // Best-effort upgrade to the encrypted form; the plaintext remains valid
      // if this write fails, so the identity is never lost here.
      writeEncryptedIdentity(hex);
    } catch {
      // keep the plaintext key; retry the upgrade on the next write
    }
    cachedSecretHex = hex;
    return hex;
  }
  if (raw.startsWith("ncryptsec1")) {
    const wrap = readStorage(IDENTITY_WRAP_KEY);
    if (!wrap) throw new StoredIdentityUnreadableError();
    try {
      hex = bytesToHex(nip49Decrypt(raw, wrap));
    } catch {
      throw new StoredIdentityUnreadableError();
    }
    cachedSecretHex = hex;
    return hex;
  }
  // A value that is neither form is stored-but-unreadable, not "unstored".
  throw new StoredIdentityUnreadableError();
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
 * The secret key behind the durable identity, for the one operation a signer
 * cannot do from outside: NIP-44 conversation keys. Only reached when neither
 * a passkey override nor a NIP-07 extension handled the call.
 */
function storedSecretKey(): Uint8Array {
  const blocked = getUserSigningBlockedReason();
  if (blocked) throw new SigningBlockedError(blocked);
  return nsecToBytes(getOrCreateIdentity());
}

/** NIP-44 encrypt `plaintext` to `peer` as the durable identity. */
export async function nip44EncryptAsUser(
  peer: string,
  plaintext: string,
): Promise<string> {
  const override = getUserNip44Override();
  if (override) {
    const out = await override.encrypt(peer, plaintext);
    if (out !== null) return out;
  }
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (provider?.nip44) return provider.nip44.encrypt(peer, plaintext);
  return nip44Encrypt(plaintext, getConversationKey(storedSecretKey(), peer));
}

/** NIP-44 decrypt a payload `peer` sent to the durable identity. */
export async function nip44DecryptAsUser(
  peer: string,
  ciphertext: string,
): Promise<string> {
  const override = getUserNip44Override();
  if (override) {
    const out = await override.decrypt(peer, ciphertext);
    if (out !== null) return out;
  }
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (provider?.nip44) return provider.nip44.decrypt(peer, ciphertext);
  return nip44Decrypt(ciphertext, getConversationKey(storedSecretKey(), peer));
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

/**
 * The identity-storage state, for UI that must distinguish "no identity yet"
 * (offer sign-in / create) from "identity present" from "identity present but
 * unreadable" (offer a recovery path — reset / re-import — never silently
 * replace it). Read-only: this never creates or overwrites anything.
 */
export function identityStorageState(): "empty" | "ready" | "unreadable" {
  const raw = readStorage(IDENTITY_STORAGE_KEY);
  if (!raw) return "empty";
  try {
    return storedIdentityHex() ? "ready" : "empty";
  } catch {
    return "unreadable";
  }
}

/**
 * Create or load the stored identity; returns the hex nsec.
 *
 * This is the only path that mints a durable key, and it MUST NOT overwrite a
 * stored blob it cannot read. When a blob exists but is unreadable,
 * `storedIdentityHex()` throws and that propagates here — the create path
 * refuses to write rather than destroy the user's real identity. A write
 * failure also propagates, so a key is never handed back memory-only.
 */
export function getOrCreateIdentity(): string {
  const existing = storedIdentityHex(); // throws on stored-but-unreadable
  if (existing) return existing;
  // Nothing is stored (storedIdentityHex returned null). Re-check the raw key
  // as defense-in-depth: never write over any blob we could not read.
  if (readStorage(IDENTITY_STORAGE_KEY)) {
    throw new StoredIdentityUnreadableError();
  }
  const hex = bytesToHex(generateSecretKey());
  writeEncryptedIdentity(hex); // propagates write failure — no memory-only key
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
