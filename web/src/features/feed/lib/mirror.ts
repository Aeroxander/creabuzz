/**
 * Optional copy of public posts to public Nostr relays (the NIP-65 outbox),
 * so people on other clients (nostter, Damus, Primal) can see and answer
 * them.
 *
 * Only the one post (kind 1) or threaded reply (kind 1111) written with the
 * box ticked is copied, and never anything carrying an `h` tag (a private
 * channel). Votes and reposts are one tap with no box to tick, so they are
 * never copied: a box ticked once must not keep sending later activity out.
 * Follow and bookmark lists are NOT copied: they are replaceable, and
 * publishing a Creaton-only list to a public relay would replace the longer
 * list someone keeps there.
 *
 * The outbox relays come from the person's NIP-65 relay list (kind 10002,
 * write relays), with two public defaults when they keep none.
 *
 * It is asked for each post and never remembered, because a copy on someone
 * else's relay cannot be recalled. The box is offered only on a server open to
 * anyone (an invite-only community's posts are not for the public), and never
 * in the contributor-only build.
 *
 * A copy rides its own socket with a bounded timeout and degrades to a log
 * line: the community relay's publish is the record and is never blocked by
 * a mirror. `web/index.html` leaves `connect-src` open to `ws: wss:`, so a
 * second socket to a public relay is allowed by the document policy; a
 * stricter host policy would only make the mirror log and skip.
 *
 * Pure and alias-free: `mirror.test.mjs` drives it under `node --test`.
 */

import { KIND_TEXT_NOTE } from "../../../shared/constants/kinds.ts";
import type { SignedEventLike } from "./feed-events.ts";

/** NIP-22 comment — a threaded reply that also deserves a public copy. */
export const KIND_NIP22_COMMENT = 1111;

/** NIP-65 relay list. */
export const KIND_RELAY_LIST = 10002;

export const DEFAULT_PUBLIC_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
];

/** How long one mirror publish may take before it is abandoned (and logged). */
export const MIRROR_TIMEOUT_MS = 5_000;

/** Never more than this many outbox relays per post — a bounded mirror. */
const MAX_OUTBOX_RELAYS = 4;

/** Where an older build remembered the box for good; only ever removed now. */
const OLD_MIRROR_KEY = "buzz.feed.mirror";

const MIRRORABLE_KINDS = new Set<number>([KIND_TEXT_NOTE, KIND_NIP22_COMMENT]);

/** Whether this event may be copied to a public relay at all. */
export function isMirrorable(event: SignedEventLike): boolean {
  if (!MIRRORABLE_KINDS.has(event.kind)) return false;
  return !event.tags.some((t) => t[0] === "h");
}

/** Whether this publish is copied: only when its author ticked the box for it. */
export function shouldMirror(
  event: SignedEventLike,
  requested: boolean | undefined,
): boolean {
  return requested === true && isMirrorable(event);
}

/**
 * Whether the composer offers the box at all: only on a server that says it is
 * open to anyone (one that has not said may be invite-only), and not in the
 * contributor-only build.
 */
export function mirrorOffered({
  raisesOffered,
  access,
}: {
  raisesOffered: boolean;
  access: string | null | undefined;
}): boolean {
  return raisesOffered && access === "open";
}

/**
 * The write relays from a NIP-65 relay list, or the public defaults when the
 * list keeps none. Read-only (`["r", url, "read"]`) entries are not an outbox.
 */
export function outboxRelays(
  listEvent: { kind: number; tags: string[][] } | null,
): readonly string[] {
  const relays = listEvent ? parseRelayList(listEvent) : [];
  return relays.length > 0 ? relays : DEFAULT_PUBLIC_RELAYS;
}

/** A NIP-65 list's write relays, deduplicated and capped. */
export function parseRelayList(event: {
  kind: number;
  tags: string[][];
}): string[] {
  if (event.kind !== KIND_RELAY_LIST) return [];
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "r" || typeof tag[1] !== "string") continue;
    const marker = tag[2];
    if (marker !== undefined && marker !== "write") continue;
    const url = tag[1].trim().replace(/\/+$/, "");
    if (!/^wss?:\/\//.test(url)) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_OUTBOX_RELAYS) break;
  }
  return out;
}

/**
 * Give `work` a deadline: past `ms` it is abandoned and rejected. The work
 * itself keeps running to completion (it cannot be recalled), but no mirror
 * call is ever awaited past its budget.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Drop the setting an older build kept, so nothing reads it as a standing yes. */
export function forgetOldMirrorSetting(): void {
  try {
    globalThis.localStorage?.removeItem(OLD_MIRROR_KEY);
  } catch {
    // Storage refused: nothing reads the key any more, so it does no harm.
  }
}
