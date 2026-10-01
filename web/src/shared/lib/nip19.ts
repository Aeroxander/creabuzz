import { decode, npubEncode } from "nostr-tools/nip19";

const HEX64 = /^[0-9a-f]{64}$/i;

export type Entity =
  | { type: "pubkey"; pubkey: string }
  | { type: "event"; id: string };

/** Parse a hex pubkey, `npub`/`nprofile`, `note`/`nevent` (optionally `nostr:`-prefixed). */
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
        return { type: "event", id: decoded.data.id };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function toNpub(pubkey: string): string {
  return npubEncode(pubkey);
}
