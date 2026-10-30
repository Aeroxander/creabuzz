/**
 * Reading the private-message inbox (NIP-17 gift wraps addressed to you) without reading all of it every time. The
 * nav's dot reads it every twenty seconds on every Home page and Messages every five; a full read is up to 500 wraps.
 * So the first read in a page's life is the full one, and every later one asks only for what can have arrived since
 * the last read, merged into what this page already has, bounded.
 *
 * "What can have arrived since" is wider than it looks: a gift wrap's time is set up to two days in the past on purpose
 * (NIP-59), so a wrap sent a second ago can carry a time from yesterday. The later reads therefore start two days
 * (and a margin for clocks that disagree) before the last read, and stay bounded by their own limit. A later read that
 * fills its limit may have missed some, so it is followed by a full read.
 *
 * Alias-free: `inbox-read.test.mjs` drives it under `node --test`.
 */

import { KIND_GIFT_WRAP } from "../../../shared/constants/kinds.ts";

/** How far into the past a gift wrap's time may be set (NIP-59). */
export const WRAP_JITTER_SECONDS = 2 * 24 * 60 * 60;
/** Room for this browser's clock and the sender's to disagree. */
export const CLOCK_SKEW_SECONDS = 10 * 60;
/** The first read, and the most wraps this page keeps. */
export const FULL_READ_LIMIT = 500;
/** A later read: what can have arrived since the last one. */
export const NEW_READ_LIMIT = 200;
/** Inboxes kept at once (one per server and account this page has read). */
const MAX_INBOXES = 8;

export interface WrapLike {
  id: string;
  created_at: number;
}

// A type, not an interface: it has to fit the relay client's open-ended filter type.
export type InboxFilter = {
  kinds: number[];
  "#p": string[];
  limit: number;
  since?: number;
};

interface Inbox<W> {
  /** Newest first, at most `FULL_READ_LIMIT`. */
  wraps: W[];
  /** When the newest read that worked was asked for (unix seconds). */
  readAt: number;
}

const inboxes = new Map<string, Inbox<WrapLike>>();

/** Forget every inbox read so far (tests; a page that signs out). */
export function resetInboxReads(): void {
  inboxes.clear();
}

/** The read to ask for next: everything (bounded) the first time, then what can have arrived since `readAt`. */
export function inboxFilter(
  me: string,
  readAt: number | null,
): { filter: InboxFilter; full: boolean } {
  const base = { kinds: [KIND_GIFT_WRAP], "#p": [me] };
  if (readAt === null)
    return { filter: { ...base, limit: FULL_READ_LIMIT }, full: true };
  return {
    filter: {
      ...base,
      since: Math.max(0, readAt - WRAP_JITTER_SECONDS - CLOCK_SKEW_SECONDS),
      limit: NEW_READ_LIMIT,
    },
    full: false,
  };
}

/** Wraps already held and wraps just read, once each, newest first, at most `cap`. */
export function mergeWraps<W extends WrapLike>(
  held: readonly W[],
  fresh: readonly W[],
  cap: number = FULL_READ_LIMIT,
): W[] {
  const byId = new Map<string, W>();
  for (const wrap of held) byId.set(wrap.id, wrap);
  for (const wrap of fresh) byId.set(wrap.id, wrap);
  return [...byId.values()]
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
    .slice(0, cap);
}

/**
 * Read the inbox of `me` on the server named by `key`, and return every wrap this page holds for it. A read that fails
 * throws and leaves what was held, and when it was read, as they were: the next read asks again from there.
 */
export async function readInboxWraps<W extends WrapLike>(
  key: string,
  me: string,
  read: (filter: InboxFilter) => Promise<W[]>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<W[]> {
  const askedAt = now();
  const held = inboxes.get(key) as Inbox<W> | undefined;
  const { filter, full } = inboxFilter(me, held?.readAt ?? null);
  let fresh = await read(filter);
  if (!full && fresh.length >= NEW_READ_LIMIT) {
    // More arrived than one later read holds: some may be past its limit, so read everything (bounded) once.
    fresh = mergeWraps(fresh, await read(inboxFilter(me, null).filter));
  }
  // Another read may have finished while this one waited: merge into what is held now, not what was held then.
  const latest = inboxes.get(key) as Inbox<W> | undefined;
  const wraps = mergeWraps(latest?.wraps ?? [], fresh);
  inboxes.delete(key);
  inboxes.set(key, {
    wraps,
    readAt: Math.max(latest?.readAt ?? 0, askedAt),
  });
  // Bounded: the inbox read longest ago goes first.
  while (inboxes.size > MAX_INBOXES) {
    const oldest = inboxes.keys().next().value;
    if (oldest === undefined) break;
    inboxes.delete(oldest);
  }
  return wraps;
}
