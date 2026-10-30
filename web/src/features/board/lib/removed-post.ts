/**
 * Why a post that was asked for is not on its board: when the board's public moderation log has its removal, the
 * newest such entry (with the moderator's public reason). A reply's removal names its thread and is not a post's.
 *
 * Alias-free; `removed-post.test.mjs` drives it under `node --test`.
 */

import type { LogEntry } from "./board-moderation.ts";

export function postRemoval(
  log: readonly Pick<
    LogEntry,
    "action" | "post" | "thread" | "at" | "reason"
  >[],
  postId: string,
): { at: number; reason: string } | null {
  let newest: { at: number; reason: string } | null = null;
  for (const entry of log) {
    if (entry.action !== "remove" || entry.thread || entry.post !== postId)
      continue;
    if (newest === null || entry.at > newest.at)
      newest = { at: entry.at, reason: entry.reason };
  }
  return newest;
}

/** What the page says in place of a post that is not on the board. */
export function missingPostText(removal: { reason: string } | null): {
  headline: string;
  reason: string | null;
} {
  if (removal === null)
    return {
      headline: "This post isn't here. It may have been deleted.",
      reason: null,
    };
  const reason = removal.reason.trim();
  return {
    headline: "A moderator removed this post.",
    reason: reason === "" ? null : reason,
  };
}
