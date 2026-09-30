/**
 * Optional copy of public posts to public Nostr relays, so people on other
 * clients (nostter, Damus, Primal) can see and answer them.
 *
 * Only posts (kind 1) and votes (kind 7) are ever copied, and never anything
 * carrying an `h` tag (a private channel). Follow and bookmark lists are NOT
 * copied: they are replaceable, and publishing a Creaton-only list to a public
 * relay would replace the longer list someone keeps there.
 *
 * It is off until the person turns it on, because a copy on someone else's
 * relay cannot be recalled.
 *
 * Pure and alias-free: `mirror.test.mjs` drives it under `node --test`.
 */

import {
  KIND_REACTION,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import type { SignedEventLike } from "./feed-events.ts";

export const DEFAULT_PUBLIC_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
];

const MIRROR_KEY = "buzz.feed.mirror";

/** Whether this event may be copied to a public relay at all. */
export function isMirrorable(event: SignedEventLike): boolean {
  if (event.kind !== KIND_TEXT_NOTE && event.kind !== KIND_REACTION) {
    return false;
  }
  return !event.tags.some((t) => t[0] === "h");
}

export function readMirrorSetting(): boolean {
  try {
    return globalThis.localStorage?.getItem(MIRROR_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMirrorSetting(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(MIRROR_KEY, "1");
    else globalThis.localStorage?.removeItem(MIRROR_KEY);
  } catch {
    // Storage refused: the setting simply stays off for this visit.
  }
}
