/**
 * The app's one server-picture cache, wired to the reader's signer.
 *
 * Signing never creates an identity: `signAsUser` would mint a key for a
 * signed-out visitor, so a read is only signed when there already is someone
 * (a stored key, a passkey, or a signer extension), and never while the
 * passkey is locked. Such a reader sees the picture's fallback instead.
 */

import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import {
  getUserSigningBlockedReason,
  hasNip07Provider,
} from "@/shared/lib/nostr-signer";
import {
  createMediaTokenSource,
  createServerMediaCache,
  type MediaSignerState,
  type ServerMediaCache,
} from "@/shared/lib/server-media";

function signerState(): MediaSignerState {
  if (getUserSigningBlockedReason()) return { blocked: "locked" };
  const pubkey = existingUserPubkey();
  if (pubkey) return { key: pubkey };
  if (hasNip07Provider()) return { key: "extension" };
  return { blocked: "signed-out" };
}

let cache: ServerMediaCache | null = null;

/**
 * Sign-out, switching identity and switching community all reload the page,
 * so one cache per page load never mixes readers or servers.
 */
export function serverMediaCache(): ServerMediaCache {
  cache ??= createServerMediaCache({
    tokens: createMediaTokenSource({ sign: signAsUser, signerState }),
    fetch: (url, init) => fetch(url, init),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });
  return cache;
}
