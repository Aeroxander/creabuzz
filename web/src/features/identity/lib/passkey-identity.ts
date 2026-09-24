/**
 * Passkey identity state machine for Buzz web.
 *
 * Identity root = the secp256k1 key derived from PRF(passkey, salt). The key
 * exists only in memory while signed in; the durable state is just the
 * credential id + salt + public keys (Nostr pubkey, secp256r1 owner key — all
 * public/safe). Same credential + salt anywhere (e.g. a synced ecosystem)
 * yields the same key. The passkey's own secp256r1 key is stored alongside as
 * the future smart-wallet (ZeroDev Kernel) owner root — see
 * `docs/identity-token-architecture.md`.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import {
  createPasskey,
  deriveNostrSecretKey,
  evmOwnerFromR1,
  getPasskeyAssertion,
  nostrPubkeyHex,
  PrfUnavailableError,
  type PasskeyIdentity,
  // Explicit extension: node --test resolves this chain without a loader
  // (tsconfig allowImportingTsExtensions); vite handles it as usual.
} from "./passkey.ts";

const CRED_KEY = "buzz.passkey.credentialId";
const SALT_KEY = "buzz.passkey.salt";
const PUBKEY_KEY = "buzz.passkey.pubkey";
const MODE_KEY = "buzz.passkey.mode";
const R1_KEY = "buzz.passkey.r1";

export type PasskeyMode = "prf" | "unlock";

export interface PasskeyState {
  credentialId: string;
  salt: Uint8Array;
  pubkey: string;
  mode: PasskeyMode;
  /** secp256r1 owner key (public), 65-byte uncompressed hex. */
  r1UncompressedHex: string | null;
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
    localStorage.setItem(MODE_KEY, state.mode);
    // Only non-secret, public material is durable: the r1 owner key is public
    // (its private half never leaves the authenticator).
    if (state.r1UncompressedHex) {
      localStorage.setItem(R1_KEY, state.r1UncompressedHex);
    } else {
      localStorage.removeItem(R1_KEY);
    }
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
    const mode: PasskeyMode =
      localStorage.getItem(MODE_KEY) === "unlock" ? "unlock" : "prf";
    return {
      credentialId,
      salt: b64ToBytes(salt),
      pubkey,
      mode,
      r1UncompressedHex: localStorage.getItem(R1_KEY),
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
  return (
    current !== null &&
    (current.mode === "unlock" || current.secretKey !== null)
  );
}

export function passkeyMode(): PasskeyMode | null {
  return loadStored()?.mode ?? null;
}

/** Mark the passkey as touched this session (unlock mode). */
export function markPasskeyUnlocked(): void {
  try {
    sessionStorage.setItem("buzz.passkey.unlocked", "1");
  } catch {
    // ignore
  }
}

export function isPasskeyUnlocked(): boolean {
  try {
    return sessionStorage.getItem("buzz.passkey.unlocked") === "1";
  } catch {
    return false;
  }
}

export function activePasskeyPubkey(): string | null {
  return isPasskeyActive() && current ? current.pubkey : null;
}

/**
 * The passkey identity's pubkey as stored on this browser, or null.
 *
 * Available before this session unlocks the credential, so "who am I" answers
 * consistently and nothing mints a second identity in the meantime.
 */
export function passkeyStoredPubkey(): string | null {
  return loadStored()?.pubkey ?? null;
}

/**
 * Both public roots of the registered passkey, straight from storage.
 *
 * Null when nothing is registered — or when the stored registration predates
 * wallet-owner capture (no r1 key); register again to get the smart-wallet
 * root. The Nostr pubkey alone stays available via `passkeyStoredPubkey`.
 */
export function passkeyIdentity(): PasskeyIdentity | null {
  const stored = loadStored();
  if (!stored?.r1UncompressedHex) return null;
  try {
    return {
      nostr: { pubkeyHex: stored.pubkey },
      evmOwner: evmOwnerFromR1(hexToBytes(stored.r1UncompressedHex)),
    };
  } catch {
    // Corrupt stored r1 material: nothing derivable to show — never guess.
    return null;
  }
}

/**
 * Refuse to adopt a re-derived key that differs from the registered one.
 *
 * Signing under a mismatched key would act as a different person than the app
 * filters for; failing loudly beats a silent identity swap.
 */
export function ensureSamePubkey(
  storedPubkey: string,
  derivedPubkey: string,
): void {
  if (storedPubkey !== derivedPubkey) {
    throw new Error(
      `This passkey re-derived a different Nostr identity than the one registered on this browser (registered ${storedPubkey}, derived ${derivedPubkey}). Signing would act as the wrong identity — register a new passkey instead.`,
    );
  }
}

/**
 * Register a passkey and derive both identity roots.
 *
 * PRF platforms (Windows Hello / Google Password Manager) derive the Nostr
 * key from the PRF output. Platforms without PRF (e.g. iCloud Keychain) fall
 * back to "unlock" mode (the web-passkey branch's shipped posture): the
 * passkey gates the browser identity with a plain assertion instead of
 * deriving it — the r1 owner root is captured either way.
 */
export async function setupPasskey(displayName: string): Promise<{
  mode: PasskeyMode;
  pubkey: string;
  identity: PasskeyIdentity | null;
}> {
  // The salt is generated here (not inside createPasskey) so the unlock-mode
  // fallback keeps it for the stored record either way.
  const salt = crypto.getRandomValues(new Uint8Array(32));
  try {
    const created = await createPasskey({
      rpName: "Creaton",
      userLabel: displayName,
      prfSalt: salt,
    });
    const state: PasskeyState = {
      credentialId: created.credentialId,
      salt: created.prfSalt,
      pubkey: created.identity.nostr.pubkeyHex,
      mode: "prf",
      r1UncompressedHex: created.identity.evmOwner.r1UncompressedHex,
      secretKey: created.nostrSecretKey,
    };
    current = state;
    persist(state);
    return { mode: "prf", pubkey: state.pubkey, identity: created.identity };
  } catch (error) {
    if (!(error instanceof PrfUnavailableError) || !error.created) throw error;
    // Unlock mode: keep the current identity (or a fresh nsec) as the Nostr
    // root and use the passkey purely as a biometric gate.
    const { getOrCreateIdentity, userPubkey } = await import(
      "@/shared/lib/identity"
    );
    getOrCreateIdentity();
    const pubkey = userPubkey();
    const state: PasskeyState = {
      credentialId: error.created.credentialId,
      salt,
      pubkey,
      mode: "unlock",
      r1UncompressedHex: error.created.r1UncompressedHex ?? null,
      secretKey: null,
    };
    current = state;
    persist(state);
    return { mode: "unlock", pubkey, identity: passkeyIdentity() };
  }
}

/**
 * Sign in with the existing passkey; PRF mode re-derives the Nostr key (and
 * refuses a mismatch), unlock mode performs a plain assertion and keeps the
 * browser identity.
 */
export async function signInPasskeyIdentity(): Promise<{ pubkey: string }> {
  const stored = loadStored();
  if (!stored) throw new Error("No passkey identity on this browser");
  if (stored.mode === "unlock") {
    await getPasskeyAssertion({ credentialId: stored.credentialId });
    current = { ...stored };
    return { pubkey: stored.pubkey };
  }
  const assertion = await getPasskeyAssertion({
    credentialId: stored.credentialId,
    prfSalt: stored.salt,
  });
  const prfOutput = assertion.prfOutput;
  if (!prfOutput) throw new PrfUnavailableError();
  const secretKey = await deriveNostrSecretKey(prfOutput);
  ensureSamePubkey(stored.pubkey, nostrPubkeyHex(secretKey));
  current = { ...stored, secretKey };
  return { pubkey: stored.pubkey };
}

/** Alias used by earlier call sites. */
export async function createPasskeyIdentity(displayName: string): Promise<{
  mode: PasskeyMode;
  pubkey: string;
  identity: PasskeyIdentity | null;
}> {
  return setupPasskey(displayName);
}

/** The in-memory Nostr secret key while signed in (never persisted). */
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
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(R1_KEY);
  } catch {
    // ignore
  }
}

/** Export the active nsec (hex) for the one-time manual backup. PRF mode:
 * the derived key. Unlock mode: the browser identity key. */
export function exportPasskeyNsec(): string | null {
  const sk = passkeySecretKey();
  if (sk) {
    return bytesToHex(sk);
  }
  try {
    return localStorage.getItem("buzz.identity.nsec");
  } catch {
    return null;
  }
}

/** Register our signer override (keeps identity.ts dependency-free). */
export function registerPasskeySigner(): void {
  void import("@/shared/lib/nostr-signer").then(
    ({
      setUserPubkeyOverride,
      setUserSignerOverride,
      setUserSigningBlockedReason,
    }) => {
      // The derived key is who the reader is, so `userPubkey()` must report it:
      // filters and own-message checks compare against that value.
      setUserPubkeyOverride(passkeyStoredPubkey);
      // Before this session unlocked the credential, signing has to fail: the
      // fall-through would create a second durable identity.
      setUserSigningBlockedReason(() =>
        loadStored() && !isPasskeyActive()
          ? "Unlock your passkey before this browser can sign."
          : null,
      );
      setUserSignerOverride(async (template) => {
        const sk = passkeySecretKey();
        if (!sk) {
          // Not signed in via passkey this session — fall through to defaults.
          return null;
        }
        const { finalizeEvent } = await import("nostr-tools/pure");
        return finalizeEvent({ ...template }, sk);
      });
    },
  );
}
