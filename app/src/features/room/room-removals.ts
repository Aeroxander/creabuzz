/**
 * Why the team took a post out of its room. When the team removes a post the server writes one public log entry (kind 45004,
 * signed by the server) with the team's reason as its words, the removed post's id (`e`), its author (`p`) and, for a
 * removed reply, the thread it was in (`thread`). The entry carries no project tag, so the room cannot ask for "the removals
 * of this room"; it reads the newest entries (and, for the posts its own replies point at and cannot find, the entries about those)
 * and keeps the ones that name a thread of this room, or such a post. Entries older than the newest 100 are not seen. Pure.
 */
import { KIND_BOARD_MODERATION_LOG } from "@creaton/core/kinds.ts";
import { parseNote } from "@creaton/core/social/feed/feed-events.ts";
import type { SignedEvent } from "../posts/use-posts";

/** The most reasons the room lists: a busy room is cut here, newest first, and says so. */
export const REMOVALS_SHOWN = 20;
/** The reason is at most this many characters (the team's own limit when it is written). */
const REASON_MAX = 280;

const HEX64 = /^[0-9a-f]{64}$/;
const tagOf = (event: SignedEvent, name: string) =>
  event.tags.find((t) => t[0] === name && typeof t[1] === "string")?.[1] ??
  null;

/** One post the team removed from this room, and what it said about it. */
export interface Removal {
  /** The removed post's id. */
  target: string;
  /** The team's reason, or "" when it gave none. */
  reason: string;
  /** When it was removed (unix seconds). */
  at: number;
}

/**
 * The ids the room's own posts point at (the thread root and the post answered) that are not among the posts that were read:
 * a post that was removed leaves its answers pointing at nothing.
 */
export function missingTargets(notes: readonly SignedEvent[]): Set<string> {
  const present = new Set(notes.map((n) => n.id));
  const missing = new Set<string>();
  for (const note of notes) {
    const parsed = parseNote(note);
    if (!parsed) continue;
    for (const id of [parsed.rootId, parsed.replyToId])
      if (id && !present.has(id)) missing.add(id);
  }
  return missing;
}

/**
 * The removals that belong to this room, newest first. `server` is the key the server signs its own records with: a log entry
 * signed by anyone else is not a removal. `roots` are the room's top-level posts that are on screen and `missing` the ids the
 * room's replies point at and cannot find.
 */
export function removalsOf(input: {
  log: readonly SignedEvent[];
  server: string | null;
  roots: ReadonlySet<string>;
  missing: ReadonlySet<string>;
}): { shown: Removal[]; cut: boolean } {
  const { server, roots, missing } = input;
  if (!server) return { shown: [], cut: false };
  const byTarget = new Map<string, Removal>();
  for (const entry of input.log) {
    if (entry.kind !== KIND_BOARD_MODERATION_LOG || entry.pubkey !== server)
      continue;
    if (tagOf(entry, "action") !== "remove") continue;
    const target = tagOf(entry, "e");
    if (!target || !HEX64.test(target)) continue;
    const thread = tagOf(entry, "thread");
    if (!missing.has(target) && !(thread && roots.has(thread))) continue;
    const kept = byTarget.get(target);
    if (kept && kept.at >= entry.created_at) continue;
    byTarget.set(target, {
      target,
      reason: entry.content.trim().slice(0, REASON_MAX),
      at: entry.created_at,
    });
  }
  const all = [...byTarget.values()].sort(
    (a, b) => b.at - a.at || (a.target < b.target ? 1 : -1),
  );
  return {
    shown: all.slice(0, REMOVALS_SHOWN),
    cut: all.length > REMOVALS_SHOWN,
  };
}
