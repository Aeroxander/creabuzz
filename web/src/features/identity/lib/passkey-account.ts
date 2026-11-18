/**
 * A passkey account's public details (D139): the passkey's credential id and its public key, which together are all a
 * browser needs, besides the passkey itself, to act as the account. The public key fixes the account's address; the
 * credential id tells the browser which passkey to ask. Neither is secret.
 *
 * Passkey sign-in keeps them only while signed in, so on their own they would be lost at sign-out, and they never exist
 * on another device: everything the account holds (starting Shares, awarded Shares, a reviewer's seat) would be out of
 * reach. So they are kept here per person, across sign-out, and published with the person's name link, so that another
 * device where the person signs in (with their recovery key) and has the same passkey (synced by their phone or
 * computer's account) can find the account again. A published copy is used only once the address it gives matches the
 * address the link names.
 */

import { passkeyIdentity } from "./passkey-identity.ts";
import { PASSKEY_CREDENTIAL_STORAGE_KEY } from "./sponsoredSender.ts";

export interface PasskeyAccountKeys {
  /** base64url credential id. */
  credentialId: string;
  /** Uncompressed P-256 public key, hex. */
  publicKey: string;
}

const PREFIX = "buzz.passkey.account:";
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{16,1024}$/;
const PUBLIC_KEY_RE = /^(?:0x)?04[0-9a-fA-F]{128}$/;

/** Well-formed keys, or null. */
export function passkeyAccountKeys(value: unknown): PasskeyAccountKeys | null {
  if (value === null || typeof value !== "object") return null;
  const { credentialId, publicKey } = value as Record<string, unknown>;
  return typeof credentialId === "string" &&
    CREDENTIAL_RE.test(credentialId) &&
    typeof publicKey === "string" &&
    PUBLIC_KEY_RE.test(publicKey)
    ? { credentialId, publicKey: publicKey.replace(/^0x/, "").toLowerCase() }
    : null;
}

/** This browser's passkey sign-in, as account keys; null without one. */
export function signInPasskeyKeys(): PasskeyAccountKeys | null {
  const identity = passkeyIdentity();
  if (!identity) return null;
  try {
    return passkeyAccountKeys({
      credentialId: localStorage.getItem(PASSKEY_CREDENTIAL_STORAGE_KEY),
      publicKey: identity.evmOwner.r1UncompressedHex,
    });
  } catch {
    return null;
  }
}

/** Keep a person's passkey account keys in this browser. Sign-out does not remove them. */
export function rememberPasskeyAccount(
  pubkey: string,
  keys: PasskeyAccountKeys,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(PREFIX + pubkey, JSON.stringify(keys));
  } catch {
    // Private windows can refuse storage: the published copy still finds the account.
  }
}

export function rememberedPasskeyAccount(
  pubkey: string,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): PasskeyAccountKeys | null {
  try {
    const raw = storage?.getItem(PREFIX + pubkey);
    return raw ? passkeyAccountKeys(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** The keys a name link published (`content.passkey` of a kind:37017 record), with the address it names. */
export function publishedPasskeyAccount(
  content: string,
): { address: string; keys: PasskeyAccountKeys } | null {
  try {
    const body = JSON.parse(content) as {
      address?: unknown;
      passkey?: unknown;
    };
    const keys = passkeyAccountKeys(body.passkey);
    return keys &&
      typeof body.address === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(body.address)
      ? { address: body.address.toLowerCase(), keys }
      : null;
  } catch {
    return null;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
