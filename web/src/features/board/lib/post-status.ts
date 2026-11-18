/**
 * Where the thing a proposal post is about stands, as the board shows it, and
 * how that orders the proposals.
 *
 * A proposal thread is not ranked by votes (a vote on a board is a signal, not
 * the DAO's vote, and ranking by it would read as support for the decision).
 * It is ordered the way a forum orders topics: what can still change comes
 * first, then by latest activity. Whether it can still change comes from the
 * decision's own state on the chain, so a post whose decision could not be read
 * or checked counts as settled and sorts after the live ones.
 *
 * Alias-free; `post-status.test.mjs` drives it under `node --test`.
 */

export type StatusTone = "open" | "good" | "wait" | "bad" | "done";

export interface PostStatus {
  /** In words: "Collecting support", "Ready to run", "Done". */
  label: string;
  tone: StatusTone;
  /** The decision can still change: gathering support, approved, or waiting to run. */
  live: boolean;
}

/** Live decisions first (0), everything else after (1). */
export function proposalPriority(
  postId: string,
  statuses: ReadonlyMap<string, PostStatus>,
): number {
  return statuses.get(postId)?.live ? 0 : 1;
}

/** The priority of each post, for `sortPosts`. */
export function priorityMap(
  postIds: readonly string[],
  statuses: ReadonlyMap<string, PostStatus>,
): Map<string, number> {
  return new Map(postIds.map((id) => [id, proposalPriority(id, statuses)]));
}
