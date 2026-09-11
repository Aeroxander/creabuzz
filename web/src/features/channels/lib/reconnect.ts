/**
 * Reconnect policy for live subscriptions.
 *
 * Kept free of `@/` imports so `reconnect.test.mjs` can drive it under
 * `node --test`.
 */

/**
 * Live state of a subscription.
 *
 * `open` means the transport is up (the relay accepted the socket); the relay
 * does not ack a REQ here, so this is the strongest signal available.
 */
export type SubscriptionStatus = "connecting" | "open" | "reconnecting";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const JITTER_RATIO = 0.3;

/**
 * Backoff before reconnect attempt `attempt` (1-based): doubling from 1s, capped
 * at 30s, with up to 30% jitter so a fleet of tabs does not retry in lockstep.
 */
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
    MAX_BACKOFF_MS,
  );
  return Math.round(base + base * JITTER_RATIO * random());
}
