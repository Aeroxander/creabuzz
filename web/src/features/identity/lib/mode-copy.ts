/**
 * Which mode a passkey credential runs in, in the reader's words.
 *
 * Two modes exist (`PasskeyMode` in `passkey-identity.ts`) and the panel used
 * to print neither's consequence: PRF re-derives the Nostr key from the
 * platform authenticator on every signature, unlock mode keeps the browser
 * key in this tab's memory for the session. Saying which one is active is the
 * difference between "why did Touch ID just ask" and a silent mystery.
 */

import type { PasskeyMode } from "./passkey-identity.ts";

export const PASSKEY_MODE_COPY: Record<PasskeyMode, string> = {
  prf: "Your Nostr key is re-derived from Touch ID at each signature (PRF)",
  unlock:
    "Session unlock — your key stays in this tab's memory until you close it",
};

/** The one-line description of a mode; null when there is no passkey. */
export function passkeyModeCopy(mode: PasskeyMode | null): string | null {
  if (mode === null) return null;
  return PASSKEY_MODE_COPY[mode];
}
