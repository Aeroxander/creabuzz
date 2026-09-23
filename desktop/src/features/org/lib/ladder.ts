// Pure resolution of a NIP-ORG performance ladder against contribution
// records. Mirror of the SDK's `evaluate_performance_link` semantics
// (crates/buzz-sdk/src/builders.rs), kept client-side because the desktop
// reads org events directly (AGENTS: prefer events over new HTTP endpoints).
//
// The window math mirrors `budget_window_start` in
// crates/buzz-relay/src/handlers/budget_enforcement.rs: day starts at UTC
// midnight, week at the most recent Monday, month at the 1st, epoch is the
// all-time cumulative window.

import type {
  BudgetLimits,
  BudgetWindow,
  ContributionRecord,
  PerformanceLink,
} from "../orgModels";

/** Start of the ladder window (unix seconds). */
export function ladderWindowStart(window: BudgetWindow, nowSecs: number): number {
  const now = new Date(nowSecs * 1000);
  switch (window) {
    case "day": {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return d.getTime() / 1000;
    }
    case "week": {
      const day = now.getUTCDay(); // 0 = Sunday
      const daysSinceMonday = (day + 6) % 7;
      const monday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday),
      );
      return monday.getTime() / 1000;
    }
    case "month": {
      const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return m.getTime() / 1000;
    }
    case "epoch":
      return 0;
  }
}

/** Counted contribution outcomes for a subject within the ladder window. */
export type LadderCounts = {
  accepted: number;
  rejected: number;
};

/**
 * Count accepted/rejected records in the window that belong to `subjectPubkey`
 * (records are signed by the contributor — the budget subject — per the
 * NIP-ORG counting rule). Records are already canonical (newest per action d),
 * so a reviewer fork can neither double-count nor resurrect a verdict.
 * A dimension filter narrows to records carrying any of the named dimensions.
 */
export function countLadderOutcomes(
  subjectPubkey: string,
  link: PerformanceLink,
  records: ContributionRecord[],
  nowSecs: number,
): LadderCounts {
  const windowStart = ladderWindowStart(link.window, nowSecs);
  const dims = link.dimensions ?? [];
  const subject = subjectPubkey.toLowerCase();
  let accepted = 0;
  let rejected = 0;
  for (const record of records) {
    if (record.author !== subject) continue;
    if (record.createdAt < windowStart) continue;
    if (dims.length > 0 && !(record.dimensions && Object.keys(record.dimensions).some((d) => dims.includes(d)))) {
      continue;
    }
    if (record.reviewStatus === "accepted") accepted += 1;
    else if (record.reviewStatus === "rejected") rejected += 1;
  }
  return { accepted, rejected };
}

/** The resolved ladder state — what the UI should show. */
export type LadderResolution = {
  /** Active tier index into `link.tiers`; null = base limits hold. */
  tier: number | null;
  /** Limits the subject currently holds. */
  activeLimits: BudgetLimits;
  /** True when the violation threshold is crossed. */
  violated: boolean;
  accepted: number;
  rejected: number;
  /** Accepted records needed to unlock the next tier (null at the top). */
  nextTierMin: number | null;
  /** Zero autonomy (revoke / require-approval violation collapse). */
  zeroed: boolean;
};

export function resolveLadder(
  link: PerformanceLink,
  counts: LadderCounts,
  baseLimits: BudgetLimits,
): LadderResolution {
  const violated =
    link.violationThreshold !== undefined &&
    counts.rejected >= link.violationThreshold.rejected;

  if (violated) {
    const zeroed = link.onViolation !== "base";
    return {
      tier: null,
      activeLimits: zeroed ? { spend: { amount: 0, unit: "usd-cents" }, runs: 0, tasks: { create: 0, approve: 0 } } : baseLimits,
      violated: true,
      accepted: counts.accepted,
      rejected: counts.rejected,
      nextTierMin: null,
      zeroed,
    };
  }

  let tier: number | null = null;
  for (let i = 0; i < link.tiers.length; i += 1) {
    if (counts.accepted >= link.tiers[i].minAccepted) tier = i;
  }
  const nextTierMin =
    tier === null ? link.tiers[0].minAccepted
    : tier + 1 < link.tiers.length ? link.tiers[tier + 1].minAccepted
    : null;

  return {
    tier,
    activeLimits: tier === null ? baseLimits : link.tiers[tier].limits,
    violated: false,
    accepted: counts.accepted,
    rejected: counts.rejected,
    nextTierMin,
    zeroed: false,
  };
}
