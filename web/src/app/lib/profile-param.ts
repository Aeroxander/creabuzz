/**
 * What a `/u/<param>` address names. A profile is a person's key, written as 64 hex characters or a pasted `npub`
 * (`nprofile`); `me` is the signed-in account. Anything else names nobody, and the page says so rather than
 * showing a made-up person with buttons that act on them.
 *
 * Alias-free: `profile-param.test.mjs` drives it under `node --test`.
 */

import { parseEntity } from "../../features/social/lib/entity.ts";

export type ProfileParam =
  /** A person. `canonical` is false when the address should be rewritten to their hex key. */
  | { kind: "person"; pubkey: string; canonical: boolean }
  /** `me`, with no account in this browser. */
  | { kind: "signed-out" }
  | { kind: "not-found" };

export function resolveProfileParam(
  param: string,
  me: string | null,
): ProfileParam {
  const raw = param.trim();
  if (raw.toLowerCase() === "me") {
    return me
      ? { kind: "person", pubkey: me.toLowerCase(), canonical: false }
      : { kind: "signed-out" };
  }
  const entity = parseEntity(raw);
  if (entity?.type !== "pubkey") return { kind: "not-found" };
  const pubkey = entity.pubkey.toLowerCase();
  return { kind: "person", pubkey, canonical: pubkey === raw };
}
