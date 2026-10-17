/**
 * How long a screen that watches the chain keeps asking it.
 *
 * A milestone someone is waiting on changes without anything happening in this browser: another holder objects, a deadline
 * passes. So the screen asks again every few seconds while it is in front of a person, but only for a while after they last
 * asked (the page was opened, they pressed Refresh, they came back to the tab): then it says it has paused and waits for
 * Refresh, so a tab left open for days does not keep reading the chain forever.
 *
 * Pure and alias-free: `bounded-poll.test.mjs` drives it under `node --test`.
 */

/** How often the chain is asked again while the screen is being watched. */
export const POLL_EVERY_MS = 15_000;
/** How long after the last time a person asked before the screen stops asking on its own. */
export const POLL_FOR_MS = 15 * 60_000;

/** The interval to ask at, or false once nobody has asked for a while. */
export function pollInterval(nowMs: number, askedAtMs: number): number | false {
  return nowMs - askedAtMs < POLL_FOR_MS ? POLL_EVERY_MS : false;
}

/** Whether the screen has stopped asking on its own. */
export function pollPaused(nowMs: number, askedAtMs: number): boolean {
  return pollInterval(nowMs, askedAtMs) === false;
}

/**
 * When to ask once more because a deadline will have passed: after the chain's own clock reaches `deadline` (unix seconds),
 * worked out from the chain clock as it was read `readAgoMs` ago. Never sooner than a moment, never beyond what a timer can
 * hold, and null when there is no deadline ahead.
 */
export function deadlineDelayMs(
  deadline: number | null,
  chainNow: number,
  readAgoMs: number,
): number | null {
  if (deadline === null || deadline <= chainNow) return null;
  const wait = (deadline - chainNow) * 1000 - readAgoMs + 1_500;
  return Math.min(Math.max(wait, 1_500), 2_147_000_000);
}
