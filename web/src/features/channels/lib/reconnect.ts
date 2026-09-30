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

/**
 * Backoff state for one subscription's reconnect loop.
 *
 * The counter must not reset when the socket merely opens. A relay that
 * accepts the connection and drops it straight away — rate limiting, a refused
 * subscription, a proxy that answers and hangs up — would otherwise re-open
 * once a second forever, which is exactly the loop the backoff exists to
 * prevent. Only a connection that proved usable resets it: the relay answered
 * this subscription (an event, or the EOSE that ends the replay).
 */
export class ReconnectBackoff {
  private attempts = 0;
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  /** Failed attempts since the connection last proved usable. */
  get attempt(): number {
    return this.attempts;
  }

  /** The socket opened. The relay has not answered anything yet. */
  onOpen(): void {}

  /** The relay answered this subscription: it is working, start over. */
  onHealthy(): void {
    this.attempts = 0;
  }

  /** The socket closed: advance and return the delay before the next try. */
  onClose(): number {
    this.attempts += 1;
    return reconnectDelay(this.attempts, this.random);
  }
}
