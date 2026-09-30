/**
 * Follow lists on standard Nostr, so they travel with the person:
 *
 * - People: the NIP-02 contact list (kind 3), `p` tags.
 * - Launches: the NIP-51 bookmark list (kind 10003), `a` tags holding launch
 *   coordinates.
 *
 * Both are replaceable: the newest one wins, and every update republishes the
 * whole list. An edit therefore starts from the latest list and keeps every
 * tag it does not understand (other clients' bookmarks, relay hints), so
 * following one launch here never wipes someone's Damus follows.
 *
 * Pure and alias-free: `lists.test.mjs` drives it under `node --test`.
 */

import {
  KIND_BOOKMARK_LIST,
  KIND_CONTACT_LIST,
} from "../../../shared/constants/kinds.ts";
import type { EventTemplate, SignedEventLike } from "./feed-events.ts";

/** The newest event of `kind` by `author`, or null. */
export function latestList(
  events: readonly SignedEventLike[],
  kind: number,
  author: string,
): SignedEventLike | null {
  let latest: SignedEventLike | null = null;
  for (const event of events) {
    if (event.kind !== kind || event.pubkey !== author) continue;
    if (
      !latest ||
      event.created_at > latest.created_at ||
      (event.created_at === latest.created_at && event.id > latest.id)
    ) {
      latest = event;
    }
  }
  return latest;
}

function values(list: SignedEventLike | null, name: string): string[] {
  return (list?.tags ?? [])
    .filter((t) => t[0] === name && typeof t[1] === "string")
    .map((t) => t[1]);
}

export function followedPeople(list: SignedEventLike | null): Set<string> {
  return new Set(values(list, "p").map((p) => p.toLowerCase()));
}

export function followedLaunches(list: SignedEventLike | null): Set<string> {
  return new Set(values(list, "a"));
}

function toggled(
  list: SignedEventLike | null,
  kind: number,
  name: string,
  value: string,
  follow: boolean,
): EventTemplate {
  const tags = (list?.tags ?? []).filter(
    (t) => !(t[0] === name && t[1] === value),
  );
  if (follow) tags.push([name, value]);
  return { kind, tags, content: list?.content ?? "" };
}

/** The updated contact list after following / unfollowing one person. */
export function withPerson(
  list: SignedEventLike | null,
  pubkey: string,
  follow: boolean,
): EventTemplate {
  return toggled(list, KIND_CONTACT_LIST, "p", pubkey.toLowerCase(), follow);
}

/** The updated bookmark list after following / unfollowing one launch. */
export function withLaunch(
  list: SignedEventLike | null,
  coordinate: string,
  follow: boolean,
): EventTemplate {
  return toggled(list, KIND_BOOKMARK_LIST, "a", coordinate, follow);
}

/**
 * The bookmark list after adding launches followed before follows were
 * published (the old browser-only list), or null when nothing is missing.
 */
export function withMigratedLaunches(
  list: SignedEventLike | null,
  coordinates: readonly string[],
): EventTemplate | null {
  const have = followedLaunches(list);
  const missing = coordinates.filter((c) => !have.has(c));
  if (missing.length === 0) return null;
  return {
    kind: KIND_BOOKMARK_LIST,
    tags: [...(list?.tags ?? []), ...missing.map((c) => ["a", c])],
    content: list?.content ?? "",
  };
}

/**
 * Launch coordinates from the old browser-only follow keys (`author:id`),
 * dropping anything that is not a well-formed key.
 */
export function coordinatesFromLegacyKeys(keys: Iterable<string>): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const split = key.indexOf(":");
    const author = key.slice(0, split);
    const id = key.slice(split + 1);
    if (split > 0 && /^[0-9a-f]{64}$/.test(author) && id !== "") {
      out.push(`37001:${author}:${id}`);
    }
  }
  return out;
}
