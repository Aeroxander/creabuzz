/**
 * Timeline rows: kind 1 notes and kind 6 reposts resolved to the notes people
 * read, newest activity first. Pure and alias-free: `social.test.mjs` drives
 * it under `node --test`.
 */

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
 * Ids of every reposted note on a page, to look up on the server. A repost carries a signed copy of the note, but that
 * copy outlives the note: its author can delete it and a moderator can remove it, and the copy would keep showing it
 * wherever it was reposted. So every original is read from the server, which no longer returns a deleted or removed
 * note, and a repost is shown only with the server's copy. Bounded by the page: at most one id per repost read.
 */
export function repostTargetIds(events: readonly SignedEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind !== KIND_REPOST) continue;
    const id = lastTagValue(e.tags, "e");
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Rows from raw kind 1 / kind 6 events. `originals` holds the reposted notes the server returned for
 * `repostTargetIds`: a repost whose original is not there (deleted, removed, or never looked up) is left out, whatever
 * its embedded copy says. A note that surfaces several times (its own post plus reposts) keeps only its newest
 * appearance.
 */
export function buildRows(
  events: readonly SignedEvent[],
  originals: ReadonlyMap<string, SignedEvent> = new Map(),
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const e of sortNewestFirst(events)) {
    let original: SignedEvent | null | undefined = e;
    let repostedBy: Row["repostedBy"];
    if (e.kind === KIND_REPOST) {
      const id = lastTagValue(e.tags, "e") ?? "";
      original = originals.get(id);
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

/**
 * What a quote card shows for the post it quotes: the post when the server returned it; a wait while it is asked;
 * "unavailable" when it could not be asked; and "removed" when the server answered without it, because it no longer
 * returns a post its author deleted or a moderator removed (never the quote's own words for it).
 */
export function quotedPostState(read: {
  found: boolean;
  isPending: boolean;
  isError: boolean;
}): "shown" | "loading" | "unavailable" | "removed" {
  if (read.found) return "shown";
  if (read.isError) return "unavailable";
  if (read.isPending) return "loading";
  return "removed";
}
