/**
 * The launch discussion's two extras: founder updates pinned at the top, and
 * the agent's thread summary card.
 *
 * - Founder updates (kind 47003) ride the discussion as pinned posts, newest
 *   first, so a reader meets the founder's own words before the replies.
 * - A thread summary (kind 39005) is written by the launch's agent and is
 *   rendered as its own card, badged "Summarized by agent …" — never as if a
 *   person wrote it. The founder opts in per launch.
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

const OPTIN_PREFIX = "buzz.feed.thread-summary:";

/** Whether the founder has opted this launch into agent summaries. */
export function readSummaryOptIn(coord: string): boolean {
  try {
    return globalThis.localStorage?.getItem(OPTIN_PREFIX + coord) === "1";
  } catch {
    return false;
  }
}

export function writeSummaryOptIn(coord: string, on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(OPTIN_PREFIX + coord, "1");
    else globalThis.localStorage?.removeItem(OPTIN_PREFIX + coord);
  } catch {
    // Storage refused: the opt-in simply stays off for this visit.
  }
}

/**
 * Generate a thread summary with the launch's agent.
 *
 * TODO: generation is not wired yet. The LLM call
 * (`/llm/chat/completions` via `features/fleet/browser-agent.ts` `askLlm`)
 * and the agent signing key (`signAsAgent`, NIP-OA `auth` tag) both live in
 * the fleet feature; a summary must be signed by the launch's agent, not by
 * the viewing founder, so the pipeline crosses that ownership boundary.
 * Reading and rendering summaries anyone publishes already works — this is
 * the one stub.
 */
export async function generateThreadSummary(_input: {
  launchCoord: string;
  thread: readonly SignedEventLike[];
}): Promise<never> {
  throw new Error("Agent thread summaries are not available yet.");
}
