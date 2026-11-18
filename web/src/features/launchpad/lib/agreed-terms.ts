/**
 * The agreed-reward terms a person reads and the two signatures that make
 * them real: the manager's proposal (an exact quantity, a deliverable slot, a
 * work deadline and a committed split) and the beneficiary's acceptance (the
 * same split, reproduced exactly). Everything here wraps the shared core
 * adapter (`agreements.ts`) and returns ordered unsigned call bytes — nothing
 * is sent, signed or funded here.
 *
 * The honey words stay straight: a quantity is an exact amount of Shares in
 * token units (18 decimals), never a cash value and never a percentage of the
 * project. A split's parts are that same quantity, divided.
 *
 * Alias-free so `agreed-terms.test.mjs` binds it under `node --test`.
 */

import {
  AGREEMENTS_SPLIT_ALL,
  agreementIdOf,
  confirmSplit,
  deliverableSlotKey,
  encodeAcceptAgreement,
  encodeProposeAgreement,
  encodeReleaseAgreement,
  encodeSettleAgreement,
  matchesSplitCommitment,
  splitHashOf,
  type AgreementTerms,
} from "@creaton/core/launchpad/agreements.ts";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import { ZERO_WORD, hashText } from "@creaton/core/launchpad/work.ts";

/** Shares are the DAO's own 18-decimal token; a quantity is in those units. */
export const AGREED_SHARE_DECIMALS = 18;

/** The most one proposal can promise: the Shares token stores supply in uint96. */
const SHARES_MAX_EXCLUSIVE = 1n << 96n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

// ── quantities ──────────────────────────────────────────────────────────────

/**
 * An exact Share quantity in words: 18 decimals, trailing zeros trimmed, the
 * whole part grouped. It is the quantity itself — not a cash value and not a
 * percentage of the project, which nothing on chain promises.
 */
export function agreedQuantityWords(units: bigint): string {
  if (typeof units !== "bigint" || units <= 0n) {
    throw new Error("a quantity is a positive bigint");
  }
  return formatUnits(units, AGREED_SHARE_DECIMALS, AGREED_SHARE_DECIMALS);
}

/** A span of seconds as the words a person reads ("7 days", "36 hours"). */
export function periodWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "no time at all";
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return hours === 1 ? "1 hour" : `${hours} hours`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Whether a text is exactly the words a hash commits to. */
export function wordsMatchHash(words: string, hash: string): boolean {
  if (typeof words !== "string" || words.trim() === "") return false;
  if (!WORD_RE.test(hash)) return false;
  try {
    return hashText(words) === hash.toLowerCase();
  } catch {
    return false;
  }
}

// ── the manager's proposal ──────────────────────────────────────────────────

/** One coauthor's part of the agreed quantity, in basis points of the whole. */
export interface CoauthorPart {
  address: string;
  /** Basis points (1..9999); the beneficiary takes the rest. */
  percentBps: number;
}

interface ProposalDraft {
  /** The mandate the work budget lives under: where `proposeAgreement` is called. */
  mandate: string;
  /** The work area the work belongs to (its project id on chain). */
  projectId: string;
  /** The work area's manager: the only wallet the mandate accepts a proposal from. */
  manager: string;
  /** When the work area itself ends: a later deadline could never be submitted. */
  projectExpiresAt: number;
  /** The chain's clock, so a deadline already past is refused here first. */
  now: number;
  /** The one person the offer names, and the first party of any split. */
  beneficiary: string;
  /** The exact quantity, in Share token units — never a price. */
  shares: bigint;
  /** When the first attempt is due (unix seconds). */
  workDeadline: bigint;
  /** What this specific deliverable is, in the manager's own words. */
  deliverable: string;
  /** The panel/policy reference recorded on the agreement (not enforced on chain). */
  policyRef: string;
  /** Coauthors sharing the quantity; empty means the beneficiary alone. */
  coauthors?: readonly CoauthorPart[];
}

type ProposalPlan =
  | {
      kind: "ok";
      /** The mandate's own `proposeAgreement` call. */
      call: { to: string; data: string };
      agreementId: string;
      slot: string;
      /** The commitment the acceptance must reproduce; zero means no split. */
      splitHash: string;
    }
  | { kind: "problem"; problem: string };

const addressOk = (value: string): boolean =>
  ADDRESS_RE.test(value) && value.toLowerCase() !== ZERO_ADDRESS;

/**
 * The manager's one call: `proposeAgreement` at the mandate, with the
 * deliverable's slot key, the work area's real criteria hash (the contract
 * takes it from the project itself) and the split commitment. The default
 * split is the beneficiary alone, committed as the zero word — never a hash of
 * an empty list, which the mandate would refuse as a malformed split.
 */
export function proposalPlan(input: ProposalDraft): ProposalPlan {
  const beneficiary = input.beneficiary.trim().toLowerCase();
  const manager = input.manager.trim().toLowerCase();
  if (!addressOk(input.mandate)) {
    return {
      kind: "problem",
      problem: "The work budget this offer belongs to could not be read.",
    };
  }
  if (!addressOk(manager)) {
    return {
      kind: "problem",
      problem: "The work area's manager could not be read.",
    };
  }
  if (!addressOk(beneficiary)) {
    return {
      kind: "problem",
      problem: "Enter the account address of the person.",
    };
  }
  if (beneficiary === manager) {
    return {
      kind: "problem",
      problem:
        "A work area's manager cannot receive its own offer. Name someone else.",
    };
  }
  if (typeof input.shares !== "bigint" || input.shares <= 0n) {
    return {
      kind: "problem",
      problem: "Say the exact quantity of Shares, more than zero.",
    };
  }
  if (input.shares >= SHARES_MAX_EXCLUSIVE) {
    return {
      kind: "problem",
      problem: "That is more Shares than can ever exist.",
    };
  }
  const deadline = Number(input.workDeadline);
  if (
    typeof input.workDeadline !== "bigint" ||
    !Number.isFinite(deadline) ||
    deadline <= input.now
  ) {
    return {
      kind: "problem",
      problem: "The work deadline must be a date still ahead.",
    };
  }
  if (deadline > input.projectExpiresAt) {
    return {
      kind: "problem",
      problem:
        "The work deadline is later than the work area's own end. Pick an earlier date.",
    };
  }
  const deliverable = input.deliverable.trim();
  if (deliverable === "") {
    return {
      kind: "problem",
      problem: "Say what the deliverable is, so the offer names one thing.",
    };
  }
  if (!WORD_RE.test(input.policyRef)) {
    return {
      kind: "problem",
      problem: "The reviewers this offer names could not be read.",
    };
  }
  let slot: string;
  let agreementId: string;
  try {
    slot = deliverableSlotKey(deliverable);
    agreementId = agreementIdOf(input.projectId, slot);
  } catch {
    return {
      kind: "problem",
      problem: "These terms could not be prepared. Check the work area.",
    };
  }
  const coauthors = input.coauthors ?? [];
  if (coauthors.length > 3) {
    return {
      kind: "problem",
      problem: "An agreed split names at most four people in all.",
    };
  }
  let splitHash = ZERO_WORD;
  if (coauthors.length > 0) {
    const parties = [beneficiary];
    const percentages = [0];
    const seen = new Set<string>([beneficiary, manager]);
    let declared = 0;
    for (const part of coauthors) {
      const address = part.address.trim().toLowerCase();
      if (!addressOk(address)) {
        return {
          kind: "problem",
          problem: "Every coauthor needs an account address.",
        };
      }
      if (seen.has(address)) {
        return {
          kind: "problem",
          problem:
            "Each person can be named only once, and never the work area's manager.",
        };
      }
      if (
        !Number.isInteger(part.percentBps) ||
        part.percentBps <= 0 ||
        part.percentBps >= AGREEMENTS_SPLIT_ALL
      ) {
        return {
          kind: "problem",
          problem: "Each coauthor's part must be a whole percent, 1 to 99.",
        };
      }
      seen.add(address);
      declared += part.percentBps;
      parties.push(address);
      percentages.push(part.percentBps);
    }
    if (declared >= AGREEMENTS_SPLIT_ALL) {
      return {
        kind: "problem",
        problem: "Leave the person the offer names a part of the Shares.",
      };
    }
    percentages[0] = AGREEMENTS_SPLIT_ALL - declared;
    try {
      confirmSplit(parties, percentages, {
        beneficiary,
        manager,
        shares: input.shares,
      });
    } catch {
      return {
        kind: "problem",
        problem:
          "That split leaves someone less than one whole Share. Raise the number of Shares or the part.",
      };
    }
    splitHash = splitHashOf(parties, percentages);
  }
  try {
    return {
      kind: "ok",
      call: {
        to: input.mandate,
        data: encodeProposeAgreement({
          projectId: input.projectId,
          beneficiary,
          shares: input.shares,
          workDeadline: input.workDeadline,
          slot,
          policyRef: input.policyRef,
          splitHash,
        }),
      },
      agreementId,
      slot,
      splitHash,
    };
  } catch {
    return {
      kind: "problem",
      problem: "These terms could not be prepared. Check the work area.",
    };
  }
}

// ── the beneficiary's acceptance ────────────────────────────────────────────

type AgreementSplitRead =
  | { kind: "declared"; parties: string[]; percentages: number[] }
  | { kind: "none" }
  | { kind: "unreadable"; reason: string };

export type AcceptancePlan =
  | { kind: "ok"; call: { to: string; data: string } }
  | { kind: "problem"; problem: string };

/**
 * The beneficiary's one call: `acceptAgreement`, reproducing the exact split
 * the proposal committed (or declaring none, where the proposal committed
 * none). Acceptance is the financial moment — the quantity is reserved then,
 * and a budget that cannot carry it answers there, never after delivery.
 */
export function acceptancePlan(input: {
  terms: AgreementTerms;
  /** The mandate the agreement lives under: where `acceptAgreement` is called. */
  mandate: string;
  /** The split as the mandate's own getter answered it. */
  split: AgreementSplitRead;
  /** The work area's manager, so a split can never pay them off the reservation. */
  manager?: string | null;
  /** The wallet about to accept: the mandate accepts only the named beneficiary. */
  wallet?: string | null;
}): AcceptancePlan {
  const { terms, split } = input;
  if (!addressOk(input.mandate)) {
    return {
      kind: "problem",
      problem: "The work budget this offer belongs to could not be read.",
    };
  }
  if (
    input.wallet &&
    input.wallet.toLowerCase() !== terms.beneficiary.toLowerCase()
  ) {
    return {
      kind: "problem",
      problem: "Only the person this offer names can accept it.",
    };
  }
  if (terms.acceptedAt !== null) {
    return {
      kind: "problem",
      problem: "These terms are already accepted.",
    };
  }
  if (split.kind === "unreadable") {
    return {
      kind: "problem",
      problem:
        "The split in these terms could not be read, so they cannot be accepted yet. Refresh in a minute.",
    };
  }
  let parties: string[] = [];
  let percentages: number[] = [];
  if (split.kind === "declared") {
    if (!matchesSplitCommitment(split, terms.splitHash)) {
      return {
        kind: "problem",
        problem:
          "The split does not match what this offer says, so nothing was sent.",
      };
    }
    try {
      const confirmed = confirmSplit(split.parties, split.percentages, {
        beneficiary: terms.beneficiary,
        manager: input.manager ?? null,
        shares: terms.shares,
      });
      parties = confirmed.parties;
      percentages = confirmed.percentages;
    } catch {
      return {
        kind: "problem",
        problem:
          "The split does not fit the number of Shares, so nothing was sent.",
      };
    }
  } else if (terms.splitHash !== ZERO_WORD) {
    return {
      kind: "problem",
      problem:
        "The split in this offer has not been read yet, so it cannot be accepted. Refresh in a minute.",
    };
  }
  try {
    return {
      kind: "ok",
      call: {
        to: input.mandate,
        data: encodeAcceptAgreement({
          agreementId: terms.id,
          shares: terms.shares,
          parties,
          percentages,
          governance: {
            beneficiary: terms.beneficiary,
            manager: input.manager ?? null,
          },
        }),
      },
    };
  } catch {
    return {
      kind: "problem",
      problem: "These terms could not be accepted. Refresh and try again.",
    };
  }
}

// ── settling and releasing ──────────────────────────────────────────────────

/**
 * The permissionless settlement, at the DAO: `settleAgreement(mandate,
 * agreementId)`. The recipients and the exact quantity come from the record —
 * no caller names an amount — and the DAO refuses anything that is not an
 * approved, window-elapsed attempt on the agreed criteria.
 */
export function settlementCall(input: {
  dao: string;
  mandate: string;
  agreementId: string;
}): { to: string; data: string } {
  return {
    to: input.dao,
    data: encodeSettleAgreement(input.dao, input.mandate, input.agreementId),
  };
}

/** Cancel (either party, pre-submission) or expire (anyone, once unrecoverable). */
export function releaseCall(input: { mandate: string; agreementId: string }): {
  to: string;
  data: string;
} {
  return {
    to: input.mandate,
    data: encodeReleaseAgreement(input.agreementId),
  };
}

// ── the words the card reads ────────────────────────────────────────────────

/** How the record stands, in one phrase. */
export function agreementStateWords(
  state: "absent" | "offered" | "agreed" | "settled" | "cancelled" | "expired",
): string {
  switch (state) {
    case "offered":
      return "Offered, waiting for the named person";
    case "agreed":
      return "Agreed; the Shares are set aside";
    case "settled":
      return "Settled";
    case "cancelled":
      return "Taken off the board";
    case "expired":
      return "Expired; the Shares set aside were released";
    default:
      return "No offer stands here";
  }
}

/**
 * The reviewer panel as it really stands: how many keys must agree, how many
 * there are, and the fact that this review is voluntary and unpaid. Three keys
 * are never called three independent people, and an unreadable panel is never
 * turned into a number.
 */
export function reviewerPolicyWords(input: {
  quorum: number;
  panel: number;
  unreadable?: boolean;
}): string {
  if (input.unreadable) {
    return "The reviewers could not be read just now, so how many must agree is not shown.";
  }
  if (input.panel > 0 && input.quorum > 0) {
    return `${input.quorum} of the ${input.panel} reviewers on this work budget must agree. Reviewing is voluntary and unpaid.`;
  }
  if (input.quorum > 0) {
    return `${input.quorum} reviewers must agree. Reviewing is voluntary and unpaid.`;
  }
  return "How many reviewers must agree is not recorded yet. Reviewing is voluntary and unpaid.";
}
