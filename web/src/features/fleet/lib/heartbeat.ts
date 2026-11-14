/**
 * When the browser agent republishes its capabilities (kind:44010).
 *
 * Kind 44010 is not replaceable on the relay: every publish is stored forever.
 * A once-a-minute beat wrote 1,440 rows per agent per day, so an announcement
 * is published when something CHANGED (status, team, tools) and otherwise as a
 * keepalive at most every HEARTBEAT_INTERVAL_MS. Liveness readers must allow a
 * beat's worth of silence: LIVENESS_WINDOW_MS is one interval plus slack.
 *
 * Alias-free so `heartbeat.test.mjs` can drive it under `node --test`.
 */

export const HEARTBEAT_INTERVAL_MS = 10 * 60_000;
export const LIVENESS_WINDOW_MS = HEARTBEAT_INTERVAL_MS + 60_000;

export interface PublishedAnnouncement {
  /** Everything about the announcement except its timestamp. */
  fingerprint: string;
  atMs: number;
}

/** Publish on change, or when the keepalive interval has elapsed. */
export function shouldPublishAnnouncement(
  last: PublishedAnnouncement | null,
  fingerprint: string,
  nowMs: number,
): boolean {
  if (!last) return true;
  if (last.fingerprint !== fingerprint) return true;
  return nowMs - last.atMs >= HEARTBEAT_INTERVAL_MS;
}
