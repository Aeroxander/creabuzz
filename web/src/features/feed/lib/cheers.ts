/**
 * Cheers on Home's feed: a small "well done" on a promise kept or on work a team accepted.
 *
 * A cheer is the reaction the timeline already uses for an up vote (kind 7, "+", naming the record), so nothing new
 * is stored and every app that counts reactions counts it. One per account: however many times an account reacts, it
 * is counted once. Only the things worth cheering can be cheered: an update in which the founder marked a promise
 * kept, and accepted work.
 *
 * Pure and alias-free: `cheers.test.mjs` drives it under `node --test`.
 */

import { KIND_REACTION } from "../../../shared/constants/kinds.ts";
import type { FeedItem } from "./record-feed.ts";

/** How many records' cheers one read asks about, and how many reactions it takes back. */
export const CHEER_TARGETS = 100;
export const CHEER_READ = 500;

/** The record a cheer on `item` names and whose it is, or null when the item is not one to cheer. */
export function cheerTarget(
  item: FeedItem,
): { id: string; pubkey: string; kind: number } | null {
  if (item.kind === "work")
    // The task itself, and the person who did the work.
    return { id: item.taskId, pubkey: item.helper, kind: 47003 };
  if (item.kind === "update" && item.answers.kept > 0)
    return { id: item.id, pubkey: item.author, kind: 47003 };
  return null;
}

interface Reaction {
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
}

/** Who cheered each of `ids`: each account once, whatever it sent and however often. */
export function cheerers(
  reactions: readonly Reaction[],
  ids: readonly string[],
): Map<string, Set<string>> {
  const wanted = new Set(ids);
  const out = new Map<string, Set<string>>();
  for (const reaction of reactions) {
    if (reaction.kind !== KIND_REACTION || reaction.content !== "+") continue;
    // A reaction names what it is about last (NIP-25).
    const target = [...reaction.tags].reverse().find((t) => t[0] === "e")?.[1];
    if (!target || !wanted.has(target)) continue;
    const set = out.get(target) ?? new Set<string>();
    set.add(reaction.pubkey);
    out.set(target, set);
  }
  return out;
}

/** "Cheer", "1 cheer", "12 cheers": the button's count in words for a screen reader. */
export function cheerCountWords(count: number): string {
  if (count === 0) return "No cheers yet";
  return count === 1 ? "1 cheer" : `${count} cheers`;
}
