/**
 * A person's score: up votes minus down votes on what they wrote, short posts and board posts alike, the way a forum
 * shows reputation beside a name. Each voter's newest vote on a post counts once, and votes on your own posts do not
 * count.
 *
 * Pure and alias-free: `author-score.test.mjs` drives it under `node --test`.
 */

import { tallyVotes } from "../../feed/lib/ranking.ts";
import type { SignedEventLike } from "../../feed/lib/feed-events.ts";

/** `votes` are `+`/`-` reactions on their short posts and board votes on their board posts. */
export function authorScore(
  author: string,
  postIds: ReadonlySet<string>,
  votes: readonly SignedEventLike[],
): number {
  const tallies = tallyVotes(
    votes.filter((vote) => vote.pubkey !== author),
    () => 1,
  );
  let score = 0;
  for (const [target, tally] of tallies) {
    if (postIds.has(target)) score += tally.up - tally.down;
  }
  return score;
}
