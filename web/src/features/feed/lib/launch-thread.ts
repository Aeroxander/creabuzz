/**
 * The launch discussion's pinned row: founder updates (kind 47003) and team posts ride it newest first, so a reader
 * meets the team's own words before the board.
 *
 * Pure and alias-free: `launch-thread.test.mjs` drives it under `node --test`.
 */

/** The structural slice of a founder update the pinned row needs. */
export interface PinnedUpdatable {
  id: string;
  author: string;
  createdAt: number;
  title: string;
  body: string;
  /** The post to open for a reply, when the update is a post people can reply to (a record-only update is not). */
  replyTo?: string;
}

/** Newest founder update first — the pinned row order is a contract. */
export function pinnedUpdates<T extends PinnedUpdatable>(
  updates: readonly T[],
): T[] {
  return [...updates].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  );
}
