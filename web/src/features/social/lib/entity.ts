/**
 * NIP-19 entities as the social client meets them: a pasted `npub`, a
 * `nostr:nprofile…` mention, a `nevent` quote reference. Pure and alias-free:
 * `social.test.mjs` drives it under `node --test`.
 */

import { decode, neventEncode, npubEncode } from "nostr-tools/nip19";

const HEX64 = /^[0-9a-f]{64}$/i;

export type Entity =
  | { type: "pubkey"; pubkey: string }
  | { type: "event"; id: string; author?: string };

/** A hex key, `npub`/`nprofile`, `note`/`nevent` — with or without `nostr:`. */
export function parseEntity(input: string): Entity | null {
  const value = input.replace(/^nostr:/, "").trim();
  if (HEX64.test(value)) return { type: "pubkey", pubkey: value.toLowerCase() };
  try {
    const decoded = decode(value);
    switch (decoded.type) {
      case "npub":
        return { type: "pubkey", pubkey: decoded.data };
      case "nprofile":
        return { type: "pubkey", pubkey: decoded.data.pubkey };
      case "note":
        return { type: "event", id: decoded.data };
      case "nevent":
        return {
          type: "event",
          id: decoded.data.id,
          author: decoded.data.author,
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function npubOf(pubkey: string): string {
  return npubEncode(pubkey);
}

export function neventOf(id: string, author?: string): string {
  return neventEncode({ id, author });
}

/** The `nostr:` URI that mentions a person (what other clients render as @name). */
export function mentionUri(pubkey: string): string {
  return `nostr:${npubEncode(pubkey)}`;
}
