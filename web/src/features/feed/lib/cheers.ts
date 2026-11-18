/**
 * Cheers on Home's feed: a small word of encouragement on a record that is worth one.
 *
 * A cheer is the reaction the timeline already uses for an up vote (kind 7, "+", naming the record), so nothing new
 * is stored and every app that counts reactions counts it. One per account: however many times an account reacts, it
 * is counted once. A cheer is only ever about a record: never about Shares, a price or a return, and it moves nothing.
 *
 * What can be cheered, and in which words:
 * - a project's start ("Good luck");
 * - a goal reached, a first update, an update in which the founder marked a promise kept, and accepted work ("Cheer");
 * - an honest miss: a goal marked missed, or an update that answers a promise as missed ("Thanks for saying so").
 *   Saying a miss on the record is the point of the record, so it is thanked and never cheered as if it were a win.
 *
 * Pure and alias-free: `cheers.test.mjs` drives it under `node --test`.
 */

import { KIND_REACTION } from "../../../shared/constants/kinds.ts";
import type { FeedItem } from "./record-feed.ts";

/** How many records' cheers one read asks about, and how many reactions it takes back. */
export const CHEER_TARGETS = 100;
export const CHEER_READ = 500;

/** Which kind of word a record gets: encouragement for a start, a cheer for a win, thanks for an honest miss. */
export type CheerKind = "luck" | "cheer" | "thanks";

/** What a record can be cheered for, or null when it is not one to cheer. */
export function cheerKind(item: FeedItem): CheerKind | null {
  switch (item.kind) {
    case "started":
      return "luck";
    case "work":
      return "cheer";
    case "goal":
      return item.state === "reached"
        ? "cheer"
        : item.state === "missed"
          ? "thanks"
          : null;
    case "update":
      if (item.answers.kept > 0 || item.first) return "cheer";
      return item.answers.missed > 0 ? "thanks" : null;
  }
}

/** The button's words: what it says, what it says once sent, and what the sender's own word is called. */
export function cheerWords(kind: CheerKind): { button: string; sent: string } {
  switch (kind) {
    case "luck":
      return { button: "Good luck", sent: "Good luck sent" };
    case "thanks":
      return { button: "Thanks for saying so", sent: "Thanks sent" };
    case "cheer":
      return { button: "Cheer", sent: "Cheered" };
  }
}

/** The record a cheer on `item` names and whose it is, or null when the item is not one to cheer. */
export function cheerTarget(
  item: FeedItem,
): { id: string; pubkey: string; kind: number } | null {
  if (cheerKind(item) === null) return null;
  if (item.kind === "work")
    // The task itself, and the person who did the work.
    return { id: item.taskId, pubkey: item.helper, kind: 47003 };
  return { id: item.id, pubkey: item.author, kind: 47003 };
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

/**
 * The button's name for a screen reader. A count is said from the first cheer on; before it there is nothing to count,
 * so nothing is said about a count at all.
 */
export function cheerLabel(
  kind: CheerKind,
  mine: boolean,
  count: number,
): string {
  const words = cheerWords(kind);
  const head = mine ? `${words.sent}.` : `${words.button}.`;
  return count > 0 ? `${head} ${cheerCountWords(count)}` : head;
}
