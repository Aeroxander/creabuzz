/**
 * The join: wizard unlock rows -> ClaimStake tranche claims (onchain).
 *
 * `unlock-plans.ts` names the gap this module closes: "nothing onchain moves
 * a token tranche when a verdict arrives." It does now -- `ClaimStake`
 * (`contracts/src/ClaimStake.sol`) is currency-agnostic: escrow the PROJECT
 * TOKEN via `fund()`, submit each milestone row as a claim, and the
 * VerifierSet's approval quorum releases the tranche to the row's claimant
 * (`settle` -> `payout`). Capital flows against attested delivery, enforced
 * onchain instead of by a treasury promise. (The pre-v3 royalty schedule
 * ride-along was removed in D150, see tag pre-deprecation-2026-10-31.)
 *
 * Mapping decisions (locked 2026-09-26):
 * - Claim text (`"m1"`) -> bytes32 as ASCII right-padded (<= 32 chars). Each
 *   launch has its own ClaimStake, so `"m1"` cannot collide across launches;
 *   right-padding keeps the onchain word human-traceable.
 * - Tranche = floor(supply * allocationPct% * percent%) computed per row from
 *   ONE floor (`floor(supply * allocationPct * percent / 10_000)`); row dust
 *   is reported, never silently reassigned.
 * - `mode: "time" | "none"` produce no claims: time vesting remains
 *   record-level (its onchain enforcer is the deferred tranche-lock work),
 *   exactly as `unlock-plans.ts` documents.
 *
 * Alias-free on purpose: `tranche-claims.test.mjs` drives it under `node --test`.
 */

import {
  type UnlockMilestone,
  type UnlockPlan,
  unlockPlanIssues,
} from "./unlock-plans.ts";

interface TrancheClaim {
  /** The wizard row's claim text (`"m1"`). */
  claim: string;
  /** The bytes32 word: 0x + 64 hex, ASCII right-padded. */
  claimIdWord: string;
  label: string;
  /** Share of the milestone allocation, percent. */
  percent: number;
  /** Tranche in token units (decimal string, floored). */
  amount: string;
}

export interface TrancheClaimPlan {
  /** Percent of total supply the plan governs. */
  allocationPct: number;
  claims: TrancheClaim[];
  /** Sum of amounts -- what `fund()` must escrow for the claims to pay out. */
  escrowRequired: string;
  /** Floored dust between the ideal milestone allocation and the sum. */
  flooredRemainder: string;
}

/**
 * `"m1"` -> `0x6d31000...0`. ASCII right-padded to 32 bytes. Refuses anything
 * that would not survive the round trip: empty, > 32 bytes, or any byte
 * outside printable ASCII (which includes NUL and control characters).
 */
export function claimIdWord(text: string): string {
  if (text.length === 0 || text.length > 32 || !/^[\x20-\x7e]+$/.test(text)) {
    throw new Error(
      `claim id must be 1-32 printable ASCII characters: ${JSON.stringify(text)}`,
    );
  }
  let hex = "";
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return `0x${hex.padEnd(64, "0")}`;
}

/**
 * One floor for the row tranche: `floor(supply * allocationPct * percent /
 * 10_000)`. Integer percents only -- a fractional wizard row is refused here
 * rather than rounded silently.
 */
export function trancheAmount(
  totalSupply: bigint,
  allocationPct: number,
  percent: number,
): bigint {
  if (
    !Number.isInteger(allocationPct) ||
    !Number.isInteger(percent) ||
    allocationPct < 0 ||
    percent < 0 ||
    allocationPct > 100 ||
    percent > 100
  ) {
    throw new Error(
      `percents must be integers in 0..100: ${allocationPct}, ${percent}`,
    );
  }
  return (totalSupply * BigInt(allocationPct) * BigInt(percent)) / 10_000n;
}

/**
 * The plan as the set of `ClaimStake` claims an operator (or agent) submits
 * and funds. Throws on an invalid plan, so a bad row never reaches a
 * reverting transaction.
 */
export function trancheClaims(
  plan: UnlockPlan | null,
  totalSupply: bigint,
): TrancheClaimPlan {
  if (plan?.mode !== "milestones") {
    return {
      allocationPct: 0,
      claims: [],
      escrowRequired: "0",
      flooredRemainder: "0",
    };
  }
  const errors = unlockPlanIssues(plan)
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.message);
  if (errors.length > 0) {
    throw new Error(`invalid unlock plan: ${errors.join("; ")}`);
  }

  let escrow = 0n;
  const claims: TrancheClaim[] = plan.milestones.map((row: UnlockMilestone) => {
    const amount = trancheAmount(totalSupply, plan.allocationPct, row.percent);
    escrow += amount;
    return {
      claim: row.claim,
      claimIdWord: claimIdWord(row.claim),
      label: row.label,
      percent: row.percent,
      amount: amount.toString(),
    };
  });

  const ideal = trancheAmount(totalSupply, plan.allocationPct, 100);
  return {
    allocationPct: plan.allocationPct,
    claims,
    escrowRequired: escrow.toString(),
    flooredRemainder: (ideal - escrow).toString(),
  };
}
