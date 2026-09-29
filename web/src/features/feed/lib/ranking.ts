/**
 * Votes, weights and ordering for the feed.
 *
 * Each voter's latest `+`/`-` on a target counts once, scaled by that voter's
 * weight (`trust-weight.ts`). A fresh key counts for little, so a swarm of new
 * accounts cannot push something to the top — the difference from pump-style
 * feeds.
 *
 * "Hot" is Reddit's formula: the log of the weighted score plus a time term,
 * so newer items start higher and older ones sink without any decay pass.
 *
 * Pure and alias-free: `ranking.test.mjs` drives it under `node --test`.
 */

import type { SignedEventLike } from "./feed-events.ts";

export interface VoteTally {
  /** Voters whose latest vote is `+` / `-` (unweighted headcount). */
  up: number;
  down: number;
  /** Sum of weighted votes. */
  score: number;
  /** The viewer's own latest vote on this target, if any. */
  mine: "+" | "-" | null;
}

export const EMPTY_TALLY: VoteTally = { up: 0, down: 0, score: 0, mine: null };

/**
 * The key a reaction counts toward: a launch's `a` coordinate when it names
 * one (so a vote survives record edits), otherwise the voted event's id.
 */
export function voteTarget(reaction: SignedEventLike): string | null {
  const coord = reaction.tags.find((t) => t[0] === "a")?.[1];
  if (coord) return coord;
  const eTags = reaction.tags.filter((t) => t[0] === "e" && t[1]);
  return eTags.length > 0 ? eTags[eTags.length - 1][1] : null;
}

/**
 * Tally reactions per target: the latest reaction per (target, voter) wins,
 * so changing a vote replaces it. Emoji reactions carry no vote.
 */
export function tallyVotes(
  reactions: readonly SignedEventLike[],
  weightOf: (pubkey: string) => number,
  viewer?: string | null,
): Map<string, VoteTally> {
  const latest = new Map<string, SignedEventLike>();
  for (const reaction of reactions) {
    const target = voteTarget(reaction);
    if (!target) continue;
    const key = `${target}\u0000${reaction.pubkey}`;
    const seen = latest.get(key);
    if (
      !seen ||
      reaction.created_at > seen.created_at ||
      (reaction.created_at === seen.created_at && reaction.id > seen.id)
    ) {
      latest.set(key, reaction);
    }
  }
  const tallies = new Map<string, VoteTally>();
  for (const reaction of latest.values()) {
    const direction =
      reaction.content === "+" || reaction.content === ""
        ? "+"
        : reaction.content === "-"
          ? "-"
          : null;
    if (!direction) continue;
    const target = voteTarget(reaction) as string;
    const tally = tallies.get(target) ?? { ...EMPTY_TALLY };
    const weight = weightOf(reaction.pubkey);
    if (direction === "+") {
      tally.up += 1;
      tally.score += weight;
    } else {
      tally.down += 1;
      tally.score -= weight;
    }
    if (viewer && reaction.pubkey === viewer) tally.mine = direction;
    tallies.set(target, tally);
  }
  return tallies;
}

/** A fixed reference second for the time term (Nov 2023). */
const HOT_EPOCH = 1_700_000_000;
/** Seconds of age that equal one order of magnitude of score (12.5 hours). */
const HOT_HALF_STEP = 45_000;

export function hotScore(score: number, createdAt: number): number {
  const order = Math.log10(Math.max(1, Math.abs(score)));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  return sign * order + (createdAt - HOT_EPOCH) / HOT_HALF_STEP;
}

export type SortMode = "hot" | "new" | "top";

export function sortByMode<T>(
  items: readonly T[],
  mode: SortMode,
  score: (item: T) => number,
  createdAt: (item: T) => number,
): T[] {
  const copy = [...items];
  if (mode === "new") {
    copy.sort((a, b) => createdAt(b) - createdAt(a));
  } else if (mode === "top") {
    copy.sort((a, b) => score(b) - score(a) || createdAt(b) - createdAt(a));
  } else {
    copy.sort(
      (a, b) =>
        hotScore(score(b), createdAt(b)) - hotScore(score(a), createdAt(a)),
    );
  }
  return copy;
}
