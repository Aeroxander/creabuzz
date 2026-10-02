/**
 * Timeline rows: kind 1 notes and kind 6 reposts resolved to the notes people
 * read, newest activity first. Pure and alias-free: `social.test.mjs` drives
 * it under `node --test`.
 */

import { verifyEvent } from "nostr-tools/pure";

import {
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import { parseNote, type SignedEventLike } from "../../feed/lib/feed-events.ts";
import { lastTagValue } from "./engagement.ts";

export type SignedEvent = SignedEventLike & { sig: string };

export interface Row {
  /** The note shown (for a repost, the original). */
  event: SignedEvent;
  /** The thread parent, when the note is a reply. */
  replyToId: string | null;
  rootId: string | null;
  /** Set when the row is someone's repost of `event`. */
  repostedBy?: { pubkey: string; at: number };
}

export function sortNewestFirst<T extends { id: string; created_at: number }>(
  events: readonly T[],
): T[] {
  const seen = new Set<string>();
  return events
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
}

export function activityAt(row: Row): number {
  return row.repostedBy?.at ?? row.event.created_at;
}

/**
 * The note embedded in a repost's `content`, only when it is authentic: the
 * id must match the repost's `e` tag and the signature must verify. Anything
 * else is ignored and the original is fetched by id instead, so a forged
 * embed can never put words in someone's mouth.
 */
export function embeddedRepostTarget(repost: SignedEvent): SignedEvent | null {
  const targetId = lastTagValue(repost.tags, "e");
  if (!repost.content || !targetId) return null;
  try {
    const parsed = JSON.parse(repost.content) as SignedEvent;
    return parsed.id === targetId && verifyEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Ids of reposted notes that must be fetched because no authentic embed exists. */
export function repostTargetsToFetch(events: readonly SignedEvent[]): string[] {
  const have = new Set<string>();
  const need = new Set<string>();
  for (const e of events) {
    if (e.kind !== KIND_REPOST) continue;
    const id = lastTagValue(e.tags, "e");
    if (!id) continue;
    if (embeddedRepostTarget(e)) have.add(id);
    else need.add(id);
  }
  return [...need].filter((id) => !have.has(id));
}

/**
 * Rows from raw kind 1 / kind 6 events. `fetched` holds originals the caller
 * looked up for reposts without a usable embed. A note that surfaces several
 * times (its own post plus reposts) keeps only its newest appearance.
 */
export function buildRows(
  events: readonly SignedEvent[],
  fetched: ReadonlyMap<string, SignedEvent> = new Map(),
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const e of sortNewestFirst(events)) {
    let original: SignedEvent | null | undefined = e;
    let repostedBy: Row["repostedBy"];
    if (e.kind === KIND_REPOST) {
      const id = lastTagValue(e.tags, "e") ?? "";
      original = embeddedRepostTarget(e) ?? fetched.get(id);
      repostedBy = { pubkey: e.pubkey, at: e.created_at };
    }
    if (!original || original.kind !== KIND_TEXT_NOTE) continue;
    if (seen.has(original.id)) continue;
    seen.add(original.id);
    const note = parseNote(original);
    rows.push({
      event: original,
      replyToId: note?.replyToId ?? null,
      rootId: note?.rootId ?? null,
      ...(repostedBy ? { repostedBy } : {}),
    });
  }
  return rows.sort((a, b) => activityAt(b) - activityAt(a));
}
