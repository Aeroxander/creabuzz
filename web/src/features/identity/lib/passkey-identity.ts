/**
 * Passkey (PRF) identity state machine for Buzz web.
 *
 * Identity root = the secp256k1 key derived from PRF(passkey, salt). The key
 * exists only in memory while signed in; the durable state is just the
 * credential id + salt + pubkey (all public/safe). Same credential + salt
 * anywhere (e.g. a synced ecosystem) yields the same key.
 */

import { getPublicKey } from "nostr-tools/pure";

import { hkdfSha256, prfProvider } from "./passkey";

const CRED_KEY = "buzz.passkey.credentialId";
const SALT_KEY = "buzz.passkey.salt";
const PUBKEY_KEY = "buzz.passkey.pubkey";

const HKDF_INFO = new TextEncoder().encode("buzz-nostr-v1");

export interface PasskeyState {
  credentialId: string;
  salt: Uint8Array;
  pubkey: string;
  /** In-memory secret key while signed in (never persisted). */
  secretKey: Uint8Array | null;
}

let current: PasskeyState | null = null;

export function b64ToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function persist(state: PasskeyState): void {
  try {
    localStorage.setItem(CRED_KEY, state.credentialId);
    localStorage.setItem(SALT_KEY, bytesToB64(state.salt));
    localStorage.setItem(PUBKEY_KEY, state.pubkey);
  } catch {
    // storage unavailable
  }
}

function loadStored(): PasskeyState | null {
  try {
    const credentialId = localStorage.getItem(CRED_KEY);
    const salt = localStorage.getItem(SALT_KEY);
    const pubkey = localStorage.getItem(PUBKEY_KEY);
    if (!credentialId || !salt || !pubkey) return null;
    return {
      credentialId,
      salt: b64ToBytes(salt),
      pubkey,
      secretKey: null,
    };
  } catch {
    return null;
  }
}

/** True when a passkey identity has been registered on this browser. */
export function hasPasskeyIdentity(): boolean {
  return loadStored() !== null;
}

/** True when the derived key is currently in memory (signed in). */
export function isPasskeyActive(): boolean {
  return current !== null && current.secretKey !== null;
}

export function activePasskeyPubkey(): string | null {
  return isPasskeyActive() ? current!.pubkey : null;
}

/** Register a new passkey identity and sign in with it. */
export async function createPasskeyIdentity(
  displayName: string,
): Promise<{ pubkey: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const provider = prfProvider();
  const { credentialId } = await provider.create(salt, displayName);
  // PRF output may be delivered on the follow-up assertion (some platforms).
  const { okm } = await provider.get(salt, credentialId);
  return signInWithOkm(credentialId, salt, okm);
}

/** Sign in with the existing passkey; returns the re-derived pubkey. */
export async function signInPasskeyIdentity(): Promise<{ pubkey: string }> {
  const stored = loadStored();
  if (!stored) throw new Error("No passkey identity on this browser");
  const provider = prfProvider();
  const { okm } = await provider.get(stored.salt, stored.credentialId);
  return signInWithOkm(stored.credentialId, stored.salt, okm);
}

async function signInWithOkm(
  credentialId: string,
  salt: Uint8Array,
  okm: ArrayBuffer,
): Promise<{ pubkey: string }> {
  const secretKey = await hkdfSha256(new Uint8Array(okm), HKDF_INFO);
  const pubkey = getPublicKey(secretKey);
  const state: PasskeyState = { credentialId, salt, pubkey, secretKey };
  current = state;
  persist(state);
  return { pubkey };
}

/** Derive the in-memory secret key (used by the signer). */
export function passkeySecretKey(): Uint8Array | null {
  return current?.secretKey ?? null;
}

/** Sign out: drop the in-memory key (nothing persisted to wipe). */
export function clearPasskeySession(): void {
  current = null;
}

/** Forget the passkey identity entirely on this browser. */
export function removePasskeyIdentity(): void {
  current = null;
  try {
    localStorage.removeItem(CRED_KEY);
    localStorage.removeItem(SALT_KEY);
    localStorage.removeItem(PUBKEY_KEY);
  } catch {
    // ignore
  }
}

/** Export the derived nsec for manual backup (only while signed in). */
export function exportPasskeyNsec(): string | null {
  const sk = passkeySecretKey();
  if (!sk) return null;
  return Array.from(sk)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Register our signer override (keeps identity.ts dependency-free). */
export function registerPasskeySigner(): void {
  void import("@/shared/lib/nostr-signer").then(({ setUserSignerOverride }) => {
    setUserSignerOverride(async (template) => {
      const sk = passkeySecretKey();
      if (!sk) {
        // Not signed in via passkey this session — fall through to defaults.
        return null;
      }
      const { finalizeEvent } = await import("nostr-tools/pure");
      return finalizeEvent({ ...template }, sk);
    });
  });
}
