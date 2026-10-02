/**
 * The social client's personal lists, on standard NIP-51 so they travel:
 *
 * - Mutes: kind 10000, public `p` tags (what Primal and other clients write).
 * - Bookmarks: kind 10003 `e` tags, held privately — new entries are
 *   NIP-44-encrypted into `content` so other members of the community cannot
 *   see what you saved. The same list also carries the feed's launch follows
 *   (`a` tags); every edit here keeps those and any tag it does not own.
 *
 * Both replace the whole list, so an edit starts from the newest copy. Pure
 * and alias-free: `social.test.mjs` drives it under `node --test`.
 */

import {
  KIND_BOOKMARK_LIST,
  KIND_MUTE_LIST,
} from "../../../shared/constants/kinds.ts";
import {
  type EventTemplate,
  replacementTimestamp,
  type SignedEventLike,
} from "../../feed/lib/feed-events.ts";
import { tagValues } from "./engagement.ts";

export function mutedPeople(list: SignedEventLike | null): Set<string> {
  return new Set(tagValues(list?.tags ?? [], "p").map((p) => p.toLowerCase()));
}

/** The mute list after muting / unmuting one person. */
export function withMuted(
  list: SignedEventLike | null,
  pubkey: string,
  muted: boolean,
): EventTemplate {
  const target = pubkey.toLowerCase();
  const tags = (list?.tags ?? []).filter(
    (t) => !(t[0] === "p" && t[1]?.toLowerCase() === target),
  );
  if (muted) tags.push(["p", target]);
  return {
    kind: KIND_MUTE_LIST,
    tags,
    content: list?.content ?? "",
    created_at: replacementTimestamp(list),
  };
}

/** Tags decrypted from a bookmark list's private `content`; empty when absent. */
export function parsePrivateTags(plaintext: string | null): string[][] {
  if (!plaintext) return [];
  const parsed: unknown = JSON.parse(plaintext);
  if (!Array.isArray(parsed))
    throw new Error("Private list is not a tag array.");
  return parsed.filter(
    (t): t is string[] =>
      Array.isArray(t) && t.every((part) => typeof part === "string"),
  );
}

/** Bookmarked note ids from both the public tags and the private entries. */
export function bookmarkedIds(
  list: SignedEventLike | null,
  privateTags: readonly string[][],
): string[] {
  return tagValues([...(list?.tags ?? []), ...privateTags], "e");
}

/**
 * The bookmark list after saving / removing one note: the public tags (with
 * that id removed, never added) and the private entries (where it is added).
 */
export function withBookmark(
  list: SignedEventLike | null,
  privateTags: readonly string[][],
  id: string,
  saved: boolean,
): {
  kind: number;
  tags: string[][];
  privateTags: string[][];
  created_at: number;
} {
  const keep = (t: string[]) => !(t[0] === "e" && t[1] === id);
  const nextPrivate = privateTags.filter(keep);
  if (saved) nextPrivate.push(["e", id]);
  return {
    kind: KIND_BOOKMARK_LIST,
    tags: (list?.tags ?? []).filter(keep),
    privateTags: nextPrivate,
    created_at: replacementTimestamp(list),
  };
}
