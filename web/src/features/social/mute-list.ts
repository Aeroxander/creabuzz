/**
 * The personal mute list (NIP-51 kind 10000), kept private.
 *
 * A mute list is readable by anyone on the server, so a public `p` tag would tell the muted person they were muted.
 * New entries go into the list's `content`, NIP-44-encrypted to yourself, as NIP-51 describes for private items.
 * Lists written before this (and by other apps) carry public `p` tags: those are still read, so old mutes keep working,
 * and the next change moves them into the private part, so the list stops naming anyone in public.
 *
 * This is the personal list only. A moderator's "mute everywhere" is a different, public sanction.
 *
 * Encryption is passed in, so `mute-list.test.mjs` drives these same functions under `node --test`.
 */

import { KIND_MUTE_LIST } from "../../shared/constants/kinds.ts";
import {
  type EventTemplate,
  replacementTimestamp,
  type SignedEventLike,
} from "../feed/lib/feed-events.ts";
import { tagValues } from "./lib/engagement.ts";
import { parsePrivateTags } from "./lib/lists.ts";

export interface MuteState {
  list: SignedEventLike | null;
  privateTags: string[][];
  /** False when the private part was written in a form this app cannot read. */
  readable: boolean;
}

/**
 * True when `content` has the shape of a NIP-44 v2 payload (base64, version byte 2). Anything else (NIP-04's
 * `?iv=`, plain text) was written by another app in a form this one cannot open.
 */
function looksLikeNip44(content: string): boolean {
  if (content.includes("?iv=") || content.startsWith("#")) return false;
  if (content.length < 132 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
    return false;
  }
  try {
    return atob(content.slice(0, 4)).charCodeAt(0) === 2;
  } catch {
    return false;
  }
}

/**
 * Your newest mute list with its private part opened.
 *
 * Only content in a form this app cannot read marks the list unreadable. A failure to decrypt (the signer refused or
 * timed out, no key, a locked passkey) rejects, so the caller keeps the last muted set it had and tries again, and
 * never treats privately muted people as unmuted.
 */
export async function readMuteState(
  list: SignedEventLike | null,
  decrypt: (ciphertext: string) => Promise<string>,
): Promise<MuteState> {
  if (!list?.content) return { list, privateTags: [], readable: true };
  if (!looksLikeNip44(list.content)) {
    // The public entries still count, but this list is never overwritten.
    return { list, privateTags: [], readable: false };
  }
  const plaintext = await decrypt(list.content);
  try {
    return { list, privateTags: parsePrivateTags(plaintext), readable: true };
  } catch {
    return { list, privateTags: [], readable: false };
  }
}

/** Everyone you muted: the old public entries and the private ones. */
export function mutedInState(state: MuteState): Set<string> {
  const tags = [...(state.list?.tags ?? []), ...state.privateTags];
  return new Set(tagValues(tags, "p").map((p) => p.toLowerCase()));
}

/**
 * The mute list after muting / unmuting one person. Every muted person ends up in the private part; the public tags
 * keep everything but people (muted words, threads), so nothing this app does not own is lost.
 */
export async function nextMuteList(
  state: MuteState,
  pubkey: string,
  muted: boolean,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<EventTemplate> {
  if (!state.readable) {
    throw new Error(
      "Your mute list was written by another app in a form this one can't read, so nothing was changed. Change who you mute in that app instead.",
    );
  }
  const target = pubkey.toLowerCase();
  const people = mutedInState(state);
  if (muted) people.add(target);
  else people.delete(target);
  const privateTags = [
    ...state.privateTags.filter((t) => t[0] !== "p"),
    ...[...people].map((p) => ["p", p]),
  ];
  return {
    kind: KIND_MUTE_LIST,
    tags: (state.list?.tags ?? []).filter((t) => t[0] !== "p"),
    content: privateTags.length
      ? await encrypt(JSON.stringify(privateTags))
      : "",
    created_at: replacementTimestamp(state.list),
  };
}
