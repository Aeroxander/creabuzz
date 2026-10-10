/**
 * Who can read a private board, and how to name someone to add.
 *
 * The server keeps a board's members as a record (kind 39002) with one
 * `["p", <pubkey>, "", <role>]` tag each. A person to add can be given as the
 * public key the app shows (64 hex characters) or as an `npub…` address.
 *
 * Alias-free; `members.test.mjs` drives it under `node --test`.
 */

import { nip19 } from "nostr-tools";

export interface BoardMember {
  pubkey: string;
  /** `owner`, `admin`, `member`, `guest` or `bot`. */
  role: string;
}

/** The members a membership record lists, in the order the server wrote them. */
export function parseMembers(tags: readonly string[][]): BoardMember[] {
  const seen = new Set<string>();
  const members: BoardMember[] = [];
  for (const tag of tags) {
    if (tag[0] !== "p" || !/^[0-9a-f]{64}$/.test(tag[1] ?? "")) continue;
    if (seen.has(tag[1])) continue;
    seen.add(tag[1]);
    members.push({ pubkey: tag[1], role: tag[3] || "member" });
  }
  return members;
}

/** The people who can add others to a board. */
export function canAddMembers(
  members: readonly BoardMember[],
  me: string | null,
): boolean {
  if (me === null) return false;
  const mine = members.find((member) => member.pubkey === me);
  return mine?.role === "owner" || mine?.role === "admin";
}

/**
 * The public key a person typed or pasted, or null when it is not one. Accepts
 * 64 hex characters (any case) or an `npub…` address, with spaces around it.
 */
export function parsePersonInput(text: string): string | null {
  const value = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(value);
      return decoded.type === "npub" ? decoded.data : null;
    } catch {
      return null;
    }
  }
  return null;
}
