/**
 * The onchain half of `ManagePanel`'s record-claim/record-verdict actions:
 * a launch record + an unlock row + its 47005 evidence -> the exact
 * `ClaimStake` calls an operator (wallet or agent) submits.
 *
 * Completes the loop `unlock-plans.ts` describes: the record's `unlocks` row
 * becomes a real claim against the launch's ClaimStake, the tranche releases
 * on the VerifierSet's approval quorum, and the same attestation can ride
 * along a royalty schedule (`tranche-claims.ts` mapping decisions).
 *
 * This module only COMPOSES (the `claim-tx.ts` / `bid-tx.ts` seam: unsigned
 * bytes). Sending stays in the wallet via the `SenderCall` shape. It returns
 * null — never a guess — when the record is not wired onchain yet.
 */

import type { LaunchRecord } from "../models.ts";
import type { UnlockMilestone } from "./unlock-plans.ts";
import {
  encodeAttest,
  encodeFund,
  encodeSubmitClaim,
  encodeSubmitClaimWithSchedule,
} from "./claim-tx.ts";
import {
  claimIdWord,
  trancheAmount,
  type TrancheScheduleRequest,
  scheduleRequestIssues,
} from "./tranche-claims.ts";

/** One sendable call in the `SenderCall` shape (`identity/lib/sponsoredSender`). */
export interface OnchainCall {
  to: string;
  data: string;
  /** Quantity string; ClaimStake calls are nonpayable. */
  value: string;
}

export interface ClaimSubmitPlan {
  /** The launch's ClaimStake (the claim call's target). */
  claimStake: string;
  /** The claim itself (submitClaim or submitClaimWithSchedule). */
  call: OnchainCall;
  /** The tranche this row releases, token base units (decimal). */
  amount: string;
  /** Treasury's `fund()` call — escrows this tranche before/at submission. */
  fundCall: OnchainCall;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Evidence as the bytes32 word ClaimStake takes. The 47005 vocabulary keeps
 * the hash 64-hex WITHOUT `0x` (`milestone-receipt.ts`); accept both.
 */
export function evidenceHashWord(evidenceHash: string): string | null {
  const trimmed = evidenceHash.trim();
  if (BYTES32_RE.test(trimmed)) return trimmed.toLowerCase();
  if (HEX64_RE.test(trimmed)) return `0x${trimmed.toLowerCase()}`;
  return null;
}

/**
 * Plan the onchain claim for one unlock row. Null when the record is not
 * wired onchain (no `claimStake` / `tokenPlan.supply` / milestone plan) or
 * the inputs are malformed — the caller falls back to the mirror-only flow
 * (treasury action against the recorded verdict).
 */
export function planClaimSubmit(args: {
  record: Pick<
    LaunchRecord,
    "claimStake" | "tokenPlan" | "unlocks" | "treasury"
  >;
  row: UnlockMilestone;
  evidenceHash: string;
  schedule?: TrancheScheduleRequest | null;
}): ClaimSubmitPlan | null {
  const { record, row, evidenceHash, schedule = null } = args;
  const claimStake = record.claimStake;
  const supply = record.tokenPlan?.supply;
  const plan = record.unlocks;
  const treasury = record.treasury;
  if (!claimStake || !ADDRESS_RE.test(claimStake)) return null;
  if (!treasury || !ADDRESS_RE.test(treasury)) return null;
  if (!supply || !plan || plan.mode !== "milestones") return null;
  if (!plan.milestones.some((m) => m.claim === row.claim)) return null;

  const evidence = evidenceHashWord(evidenceHash);
  if (!evidence) return null;

  let amount: bigint;
  try {
    amount = trancheAmount(BigInt(supply), plan.allocationPct, row.percent);
  } catch {
    return null;
  }
  if (amount <= 0n) return null;

  let claimWord: string;
  try {
    claimWord = claimIdWord(row.claim);
  } catch {
    return null;
  }
  const call = schedule
    ? {
        to: claimStake,
        data: encodeSubmitClaimWithSchedule(
          claimWord,
          amount,
          0n,
          evidence,
          schedule.weight,
          schedule.term,
          schedule.band,
          amount, // the tranche IS the earned allocation (double-pay rule)
        ),
        value: "0x0",
      }
    : {
        to: claimStake,
        data: encodeSubmitClaim(claimWord, amount, 0n, evidence),
        value: "0x0",
      };

  return {
    claimStake,
    call,
    amount: amount.toString(),
    fundCall: {
      to: claimStake,
      data: encodeFund(treasury, amount),
      value: "0x0",
    },
  };
}

/** Schedule request issues, re-exported so the UI can gate the button. */
export { scheduleRequestIssues };

/**
 * The verdict half: the accepted verifier's `attest(claimId, approve)` on the
 * launch's VerifierSet. Null when the record has no `verifierSet` wiring or
 * the claim text is malformed — the mirror-only flow applies then.
 */
export function planVerdictSubmit(
  record: Pick<LaunchRecord, "verifierSet">,
  claimText: string,
  approve: boolean,
): OnchainCall | null {
  const verifierSet = record.verifierSet;
  if (!verifierSet || !ADDRESS_RE.test(verifierSet)) return null;
  let word: string;
  try {
    word = claimIdWord(claimText);
  } catch {
    return null;
  }
  return { to: verifierSet, data: encodeAttest(word, approve), value: "0x0" };
}
