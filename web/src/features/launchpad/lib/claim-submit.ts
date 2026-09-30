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
import { encodeErc20Approve } from "./bid-tx.ts";
import {
  encodeAttest,
  encodeFund,
  encodePayout,
  encodeSettle,
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
  /**
   * The treasury's escrow for this tranche, in send order: approve the token
   * to the ClaimStake, then `fund(claimId, amount)`. Send only AFTER the claim
   * itself landed (`fund` reverts for a claim that does not exist yet). Null
   * when the record has no token address to approve.
   */
  fundCalls: OnchainCall[] | null;
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
    "claimStake" | "tokenPlan" | "unlocks" | "treasury" | "token"
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
    fundCalls:
      record.token && ADDRESS_RE.test(record.token)
        ? [
            {
              to: record.token,
              data: encodeErc20Approve(claimStake, amount),
              value: "0x0",
            },
            {
              to: claimStake,
              data: encodeFund(claimWord, amount),
              value: "0x0",
            },
          ]
        : null,
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

/**
 * `settle` or `payout` for one claim on the launch's ClaimStake. Null when the
 * record has no ClaimStake or the claim text is malformed.
 */
export function planClaimAction(
  record: Pick<LaunchRecord, "claimStake">,
  claimText: string,
  action: "settle" | "payout",
): OnchainCall | null {
  const claimStake = record.claimStake;
  if (!claimStake || !ADDRESS_RE.test(claimStake)) return null;
  let word: string;
  try {
    word = claimIdWord(claimText);
  } catch {
    return null;
  }
  return {
    to: claimStake,
    data: action === "settle" ? encodeSettle(word) : encodePayout(word),
    value: "0x0",
  };
}
