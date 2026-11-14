/**
 * When the Work tab should read the chain again by itself: a claim's step changes without anyone acting when its
 * challenge window ends (it can then be taken) or its deadline passes (it can then be closed as lapsed). The page reads
 * again just after the soonest such moment, so it never keeps offering a step that has moved on.
 *
 * Pure and alias-free: `work-refresh.test.mjs` drives it under `node --test`.
 */

/** The shape of the work read this needs (structural, so the snapshot type fits). */
export interface WorkClock {
  chainTime: number;
  mandates: readonly {
    challengeWindow: number;
    claims: readonly {
      record: { status: string; expiresAt: number; releasedAt: number };
    }[];
  }[];
}

/** The soonest moment after `chainTime` at which a claim's step changes by itself, in chain seconds; null when none. */
export function nextMoment(work: WorkClock): number | null {
  let soonest: number | null = null;
  const consider = (at: number) => {
    if (at > work.chainTime && (soonest === null || at < soonest)) soonest = at;
  };
  for (const mandate of work.mandates) {
    for (const claim of mandate.claims) {
      const { status, expiresAt, releasedAt } = claim.record;
      if (status === "Approved" && releasedAt > 0) {
        consider(releasedAt + mandate.challengeWindow);
      } else if (status === "Open" && expiresAt > 0) {
        // The contract lets it lapse only once the deadline is past (`block.timestamp > expiresAt`).
        consider(expiresAt + 1);
      }
    }
  }
  return soonest;
}

/** Longest a timer waits: beyond it, coming back to the page reads it again anyway. */
export const MAX_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * Milliseconds to wait before reading again for `moment` (chain seconds), seen at `chainTime`: a few seconds after it,
 * so the next block is past it too. Null when it is too far away to be worth a timer.
 */
export function refreshDelay(moment: number, chainTime: number): number | null {
  const ms = (moment - chainTime) * 1000 + 3_000;
  if (ms > MAX_REFRESH_DELAY_MS) return null;
  return Math.max(ms, 3_000);
}
