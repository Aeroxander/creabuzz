/**
 * The web half of the browser→desktop account handoff: confirm, encrypt the
 * account payload to the desktop's one-time key, hand it back over the
 * `creaton://` callback. The pure payload shape and every refusal rule live
 * in `@creaton/core/link-device.ts` (shared with the desktop); this module
 * adds the crypto and the account-secret lookup.
 *
 * The payload must never be logged: there are no `console.*` calls here and
 * error paths surface only generic messages.
 */

import { encrypt, getConversationKey } from "nostr-tools/nip44";
import { npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

import {
  buildLinkDeviceCallback,
  buildLinkDevicePayload,
  type LinkDeviceRequest,
  serializeLinkDevicePayload,
} from "@creaton/core/link-device.ts";

import {
  getOrCreateIdentity,
  nsecToBytes,
  storedIdentityHex,
} from "../../../shared/lib/identity.ts";
import { hasPasskeyIdentity, passkeySecretKey } from "./passkey-identity.ts";

/** What the confirm action produces: the redirect URL and the linked npub. */
export type LinkDeviceHandoff = {
  /** The `creaton://` callback carrying the encrypted payload in `p`. */
  url: string;
  /** The account's npub — both sides show it once linked. */
  npub: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The account secret key to hand over: the unlocked passkey-derived key when
 * that is who the reader is, else the stored browser key (creating one only
 * through the identity module's normal path). Returns null when a passkey
 * identity exists but this session is locked — the caller must have the user
 * sign in first; sharing while locked would bypass the unlock gate.
 */
export function linkDeviceAccountSecretHex(): string | null {
  const passkey = passkeySecretKey();
  if (passkey) return bytesToHex(passkey);
  if (hasPasskeyIdentity()) return null;
  return storedIdentityHex() ?? getOrCreateIdentity();
}

/**
 * Build the handoff redirect for one confirmed request: the payload is
 * NIP-44-encrypted to the desktop's one-time `pub` with the account key as
 * the sender, so the ciphertext in the URL is unreadable without the
 * desktop's matching secret key. The redirect's `from` carries the account
 * pubkey — a NIP-44 payload does not identify its sender, and the desktop
 * also binds `from` to the payload's `sk`. Throws when the callback is not a
 * `creaton://` URL (see `buildLinkDeviceCallback`) — no URL is ever produced
 * for a foreign callback.
 */
export function buildLinkDeviceRedirect(input: {
  request: LinkDeviceRequest;
  secretKeyHex: string;
  nowMs?: number;
}): LinkDeviceHandoff {
  const { request, secretKeyHex } = input;
  const payload = buildLinkDevicePayload({
    secretKeyHex,
    nonce: request.nonce,
    nowMs: input.nowMs,
  });
  const conversationKey = getConversationKey(
    nsecToBytes(secretKeyHex),
    request.pub,
  );
  const ciphertext = encrypt(
    serializeLinkDevicePayload(payload),
    conversationKey,
  );
  const accountPub = getPublicKey(nsecToBytes(secretKeyHex));
  return {
    url: buildLinkDeviceCallback(request.cb, ciphertext, accountPub),
    npub: npubEncode(accountPub),
  };
}
