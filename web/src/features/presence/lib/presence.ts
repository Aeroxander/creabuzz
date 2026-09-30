/**
 * Pure presence logic shared by the presence hooks and indicators.
 *
 * Event shape (mirrors `desktop/src/features/presence/lib/presence.ts`):
 * a live kind:20001 event is self-signed by its author and its content is the
 * status ("online" | "away" | "offline"). The subject is always the event
 * author — a `p` tag is NOT trusted here, a client could forge one to spoof
 * another user. Kind integers live in `crates/buzz-core/src/kind.rs`
 * (KIND_PRESENCE_UPDATE = 20001).
 *
 * Presence is an ephemeral relay-side feature (Redis with a TTL). When the
 * relay lacks it, subscriptions simply deliver nothing and the UI shows
 * nothing — that is the intended degradation.
 */

export type PresenceStatus = "online" | "away" | "offline";

/** One live presence observation with its expiry. */
export interface PresenceEntry {
  status: PresenceStatus;
  expiresAt: number;
}

export type PresenceState = Record<string, PresenceEntry>;

// Keep the local optimistic cache and relay expiry at three heartbeat
// windows (desktop's values; the relay owns the authoritative TTL).
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
export const PRESENCE_TTL_MS = 3 * PRESENCE_HEARTBEAT_INTERVAL_MS;
export const PRESENCE_PRUNE_INTERVAL_MS = 30_000;
/** Cap on authors tracked by one presence subscription. */
export const PRESENCE_MAX_TRACKED = 24;

// Away means "human not at the machine" (Slack/Discord semantics), never
// "the app is not the focused window". OS-wide idle is authoritative when the
// platform exposes it; otherwise fall back to in-app activity.
export const PRESENCE_IDLE_TIMEOUT_MS = 10 * 60_000;

export function parseLivePresenceEvent(event: {
  pubkey: string;
  content: string;
}): { pubkey: string; status: PresenceStatus } | null {
  const status = event.content;
  if (status !== "online" && status !== "away" && status !== "offline") {
    return null;
  }
  return { pubkey: event.pubkey.toLowerCase(), status };
}

export function resolveAutomaticPresenceStatus(
  osIdleSeconds: number | null,
  lastActivityAt: number,
  now: number,
): PresenceStatus {
  if (osIdleSeconds !== null) {
    return osIdleSeconds * 1000 >= PRESENCE_IDLE_TIMEOUT_MS ? "away" : "online";
  }
  return now - lastActivityAt >= PRESENCE_IDLE_TIMEOUT_MS ? "away" : "online";
}

/**
 * Drop expired observations. Returns the same reference when nothing changed
 * so memoized consumers do not re-render on a no-op prune tick.
 */
export function prunePresenceState(
  state: PresenceState,
  now: number,
): PresenceState {
  let changed = false;
  const next: PresenceState = {};
  for (const [pubkey, entry] of Object.entries(state)) {
    if (entry.expiresAt > now) {
      next[pubkey] = entry;
    } else {
      changed = true;
    }
  }
  return changed ? next : state;
}

export function presenceLabel(status: PresenceStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "away":
      return "Away";
    case "offline":
      return "Offline";
  }
}

export function presenceDotClassName(status: PresenceStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500";
    case "away":
      return "bg-amber-500";
    case "offline":
      return "bg-muted-foreground/35";
  }
}
