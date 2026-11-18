/**
 * How many tokens each milestone would hold back, worked out from the launch record alone, so a backer can see it before
 * the project has launched and there is a lock on the chain to ask.
 *
 * The record carries the sale tranche in whole tokens, the share of the supply that tranche is, the share of the supply
 * the milestones govern, and each milestone's share of that. Everything is integer arithmetic on whole tokens, scaled to
 * 18 decimals at the end (Shares have 18). A record that does not say enough gives null for each, never a guess.
 *
 * Pure and alias-free: `milestone-plan.test.mjs` drives it under `node --test`.
 */

const SCALE = 10n ** 18n;

export interface PlanRecord {
  tokenPlan: { supply: string } | null;
  allocation: { sale: number };
  unlocks: {
    allocationPct: number;
    milestones: readonly { percent: number }[];
  } | null;
}

/** Basis points of a percentage, as a whole number (so 33.33% is 3333). */
const bps = (percent: number): bigint => BigInt(Math.round(percent * 100));

export function plannedMilestoneTokens(record: PlanRecord): (bigint | null)[] {
  const milestones = record.unlocks?.milestones ?? [];
  const none = milestones.map(() => null);
  const supply = record.tokenPlan?.supply ?? "";
  if (!/^[0-9]+$/.test(supply)) return none;
  const saleShare = bps(record.allocation.sale);
  if (saleShare <= 0n) return none;
  // The sale tranche is `sale` percent of everything: the whole supply is that many times larger.
  const total = (BigInt(supply) * 10_000n) / saleShare;
  const governed = (total * bps(record.unlocks?.allocationPct ?? 0)) / 10_000n;
  // A plan that governs nothing (or does not say) holds nothing back: "about 0 tokens" would be a claim, not a gap.
  if (governed <= 0n) return none;
  return milestones.map(
    (milestone) => (governed * bps(milestone.percent) * SCALE) / 10_000n,
  );
}
