/**
 * The launch discussion's two extras: founder updates pinned at the top, and
 * a thread summary card when one was published.
 *
 * - Founder updates (kind 47003) ride the discussion as pinned posts, newest
 *   first, so a reader meets the founder's own words before the replies.
 * - A thread summary (kind 39005) is written by the launch's agent and is
 *   rendered as its own card, badged "Summarized by agent …" — never as if a
 *   person wrote it. Nothing here writes one: the page only shows a summary
 *   someone already published.
 *
 * Pure and alias-free: `launch-thread.test.mjs` drives it under `node --test`.
 */

import { KIND_THREAD_SUMMARY } from "../../../shared/constants/kinds.ts";
import type { SignedEventLike } from "./feed-events.ts";

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

export interface ThreadSummary {
  id: string;
  author: string;
  createdAt: number;
  text: string;
  /** The launch coordinate this summary is about, when the event names one. */
  launchCoord: string | null;
}

/** A kind 39005 thread-summary event, or null when it is not one. */
export function parseThreadSummary(
  event: SignedEventLike,
): ThreadSummary | null {
  if (event.kind !== KIND_THREAD_SUMMARY) return null;
  const text = event.content.trim();
  if (text === "") return null;
  const launchCoord =
    event.tags.find((t) => t[0] === "a" && typeof t[1] === "string")?.[1] ??
    null;
  return {
    id: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    text,
    launchCoord,
  };
}

/** The freshest summary, or null when there is none. */
export function newestSummary(
  summaries: readonly ThreadSummary[],
): ThreadSummary | null {
  let best: ThreadSummary | null = null;
  for (const summary of summaries) {
    if (!best || summary.createdAt > best.createdAt) best = summary;
  }
  return best;
}
