/**
 * Non-secret passkey material on disk — the desktop mirror of the web app's
 * `buzz.passkey.*` storage (`web/src/features/identity/lib/passkey-identity.ts`),
 * same keys and same base64 encoding so the two surfaces read each other's
 * material.
 *
 * ONLY non-secret material is stored here: credential id, PRF salt, the two
 * PUBLIC roots, and the display mode. The Nostr secret key and PRF outputs
 * stay in memory (docs/identity-token-architecture.md) — never pass them to
 * this module.
 */

const CRED_KEY = "buzz.passkey.credentialId";
const SALT_KEY = "buzz.passkey.salt";
const PUBKEY_KEY = "buzz.passkey.pubkey";
const MODE_KEY = "buzz.passkey.mode";
const R1_KEY = "buzz.passkey.r1";
const CEREMONY_KEY = "buzz.passkey.ceremony";

export type PasskeyMode = "prf" | "unlock";

export interface PasskeyState {
  credentialId: string;
  /** PRF `eval.first` salt — non-secret, makes re-derivation deterministic. */
  salt: Uint8Array;
  /** Nostr pubkey hex (public root). */
  pubkey: string;
  mode: PasskeyMode;
  /** secp256r1 owner root (public), when known. */
  r1UncompressedHex: string | null;
  /**
   * The ceremony's RP id/origin coupling record (see
   * `passkeyContract.ts` `CeremonyProvenance`): the in-contract WebAuthn
   * validator must use `expectedRPID === ceremony.rpId` and an
   * `expectedOrigin` containing `ceremony.origin` when verifying this
   * identity's assertions. Null for legacy records stored before this
   * existed.
   */
  ceremony: { rpId: string; origin: string } | null;
}

/** Minimal storage surface (localStorage-compatible) — injectable for tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage {
  const storage = (globalThis as { localStorage?: KeyValueStorage })
    .localStorage;
  if (!storage) {
    throw new Error(
      "localStorage is unavailable — passkey state cannot be stored",
    );
  }
  return storage;
}

/** Standard base64 (web `bytesToB64`); `b64ToBytes` accepts either alphabet. */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Persist the non-secret record (one atomic-enough write per field set). */
export function savePasskeyState(
  state: PasskeyState,
  storage: KeyValueStorage = defaultStorage(),
): void {
  storage.setItem(CRED_KEY, state.credentialId);
  storage.setItem(SALT_KEY, bytesToB64(state.salt));
  storage.setItem(PUBKEY_KEY, state.pubkey);
  storage.setItem(MODE_KEY, state.mode);
  if (state.r1UncompressedHex) {
    storage.setItem(R1_KEY, state.r1UncompressedHex);
  } else {
    storage.removeItem(R1_KEY);
  }
  if (state.ceremony) {
    storage.setItem(CEREMONY_KEY, JSON.stringify(state.ceremony));
  } else {
    storage.removeItem(CEREMONY_KEY);
  }
}

/** Load the non-secret record, or null when none is stored. */
export function loadPasskeyState(
  storage: KeyValueStorage = defaultStorage(),
): PasskeyState | null {
  const credentialId = storage.getItem(CRED_KEY);
  const salt = storage.getItem(SALT_KEY);
  const pubkey = storage.getItem(PUBKEY_KEY);
  if (!credentialId || !salt || !pubkey) return null;
  return {
    credentialId,
    salt: b64ToBytes(salt),
    pubkey,
    mode: storage.getItem(MODE_KEY) === "unlock" ? "unlock" : "prf",
    r1UncompressedHex: storage.getItem(R1_KEY),
    ceremony: readCeremony(storage.getItem(CEREMONY_KEY)),
  };
}

/**
 * Parse the persisted ceremony coupling record. Unparseable legacy values
 * degrade to `null` (the record is then treated as unknown, never invented).
 */
function readCeremony(raw: string | null): PasskeyState["ceremony"] {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { rpId?: unknown; origin?: unknown };
    if (typeof value.rpId === "string" && typeof value.origin === "string") {
      return { rpId: value.rpId, origin: value.origin };
    }
  } catch {
    // fall through — never fail a load on a corrupt provenance record
  }
  return null;
}

export function hasPasskeyIdentity(
  storage: KeyValueStorage = defaultStorage(),
): boolean {
  return loadPasskeyState(storage) !== null;
}

/** Remove the non-secret record (sign-out / reset). */
export function clearPasskeyState(
  storage: KeyValueStorage = defaultStorage(),
): void {
  storage.removeItem(CRED_KEY);
  storage.removeItem(SALT_KEY);
  storage.removeItem(PUBKEY_KEY);
  storage.removeItem(MODE_KEY);
  storage.removeItem(R1_KEY);
  storage.removeItem(CEREMONY_KEY);
}
