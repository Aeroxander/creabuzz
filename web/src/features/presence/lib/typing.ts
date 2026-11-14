/**
 * Pure typing-indicator logic: throttle, event parsing, TTL pruning and the
 * "X is typing…" label.
 *
 * Event shape (mirrors `desktop/src/features/messages/useChannelTyping.ts` and
 * `useTypingBroadcast.ts`): a kind:20002 event carries an `h` tag for the
 * channel and an optional `e` tag for the thread being replied to. Kind
 * integer lives in `crates/buzz-core/src/kind.rs` (KIND_TYPING_INDICATOR =
 * 20002). Typing is ephemeral: it is never persisted and must never trigger a
 * reconnect on its own.
 */

export const KIND_TYPING_INDICATOR = 20002;

/** At most one typing event per interval per channel (desktop's value). */
export const TYPING_SEND_INTERVAL_MS = 3_000;
/** A typing observation expires this long after its event (desktop's value). */
export const TYPING_INDICATOR_TTL_MS = 8_000;
export const TYPING_PRUNE_INTERVAL_MS = 1_000;

export interface TypingEntry {
  pubkey: string;
  threadHeadId: string | null;
  firstSeenAt: number;
  expiresAt: number;
}

export type TypingState = Record<string, TypingEntry>;

export function typingStateKey(pubkey: string, threadHeadId: string | null) {
  return `${pubkey}:${threadHeadId ?? "channel"}`;
}

function getTag(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * Validate one live typing event for a channel view. Returns null for the
 * wrong channel, the viewer's own typing, or an event whose TTL already
 * expired (a stale replay must not resurrect old state).
 */
export function parseTypingEvent(
  event: { kind: number; pubkey: string; created_at: number; tags: string[][] },
  opts: { channelId: string; selfPubkey?: string | null; now: number },
): { pubkey: string; threadHeadId: string | null } | null {
  if (event.kind !== KIND_TYPING_INDICATOR) return null;
  if (getTag(event.tags, "h") !== opts.channelId) return null;
  const pubkey = event.pubkey.toLowerCase();
  if (opts.selfPubkey && pubkey === opts.selfPubkey.toLowerCase()) return null;
  if (event.created_at * 1_000 + TYPING_INDICATOR_TTL_MS <= opts.now) {
    return null;
  }
  return { pubkey, threadHeadId: getTag(event.tags, "e") ?? null };
}

/**
 * Drop expired typers. Returns the same reference when nothing changed so
 * memoized consumers do not re-render on a no-op prune tick.
 */
export function pruneTypingState(state: TypingState, now: number): TypingState {
  let changed = false;
  const next: TypingState = {};
  for (const [key, entry] of Object.entries(state)) {
    if (entry.expiresAt > now) {
      next[key] = entry;
    } else {
      changed = true;
    }
  }
  return changed ? next : state;
}

export interface TypingThrottle {
  /** True at most once per interval; the caller sends only on true. */
  shouldSend(): boolean;
  /** Forget the last send, e.g. when the channel changes. */
  reset(): void;
}

/**
 * Throttle for outgoing typing broadcasts. Without this, every keystroke
 * publishes an event — the interval is what keeps typing cheap.
 */
export function createTypingThrottle(
  intervalMs: number,
  now: () => number = () => Date.now(),
): TypingThrottle {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  return {
    shouldSend() {
      const current = now();
      if (current - lastSentAt < intervalMs) return false;
      lastSentAt = current;
      return true;
    },
    reset() {
      lastSentAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/**
 * The plain line shown above the composer: "Alice is typing…",
 * "Alice and Bob are typing…", or "N people are typing…". Null when nobody is.
 * Names are deduplicated: one person typing in two threads is one name.
 */
export function typingSummaryLabel(names: string[]): string | null {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return `${unique[0]} is typing…`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are typing…`;
  return `${unique.length} people are typing…`;
}
