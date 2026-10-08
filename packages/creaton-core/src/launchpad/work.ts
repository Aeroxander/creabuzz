/**
 * The contributor path as data: what a mandate, its projects and its claims look like on chain, in plain words,
 * and the one step each person can take next.
 *
 * Pure: bytes in, bytes out. The reads and the sends belong to the app; this module only knows the contracts'
 * shapes (`TreasuryMandate`, `ClaimStake`, `VerifierSet`) and is pinned against `cast` in `work.test.mjs`, the same
 * vectors `buzz launchpad work` is pinned against.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

// ---- calls ---------------------------------------------------------------------------------

export const SIGNATURES = {
  mandateClaims: "claims()",
  mandateVerifiers: "verifiers()",
  mandateClosed: "closed()",
  mandateExpiresAt: "expiresAt()",
  mandateBudget: "budget()",
  mandateShareBudget: "shareBudget()",
  mandateSharesAllocated: "sharesAllocated()",
  mandateAllocated: "allocated()",
  project: "projects(bytes32)",
  claimProject: "claimProject(bytes32)",
  awarded: "contributionAwarded(bytes32)",
  claim: "claims(bytes32)",
  challengeWindow: "challengeWindow()",
  approvalCount: "approvalCount(bytes32)",
  objectionCount: "objectionCount(bytes32)",
  quorum: "quorum()",
  reviewer: "verifiers(address)",
  attest: "attest(bytes32,bool)",
  settle: "settle(bytes32)",
  payout: "payout(bytes32)",
  bind: "fundMilestone(bytes32,bytes32,address)",
  policy: "votingWeight()",
  factory: "mandateFactory()",
} as const;

export const TOPIC_MANDATE_CREATED = topicOf(
  "MandateCreated(address,address,address,uint128,uint128,uint128,uint128)",
);
export const TOPIC_PROJECT_APPROVED = topicOf(
  "ProjectApproved(bytes32,address,uint128,uint128,uint64,bytes32)",
);
export const TOPIC_CLAIM_SUBMITTED = topicOf(
  "ClaimSubmitted(bytes32,address,uint256,uint256,bytes32)",
);

function topicOf(signature: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`;
}

/** An address as a 32-byte topic, for filtering logs by an indexed address. */
export function addressTopic(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error(`not an address: ${address}`);
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** A read with no arguments. */
export function encodeCall0(signature: string): string {
  return selectorOf(signature);
}

/** A read or write that takes one id. */
export function encodeCallId(signature: string, id: string): string {
  assertWord(id, "id");
  return encodeFunctionData(signature, ["bytes32"], [id]);
}

export function encodeAttest(claimId: string, approve: boolean): string {
  assertWord(claimId, "claim id");
  return encodeFunctionData(
    SIGNATURES.attest,
    ["bytes32", "bool"],
    [claimId, approve],
  );
}

export function encodeBind(
  projectId: string,
  claimId: string,
  contributor: string,
): string {
  assertWord(projectId, "project id");
  assertWord(claimId, "claim id");
  if (!ADDRESS_RE.test(contributor))
    throw new Error(`not an address: ${contributor}`);
  return encodeFunctionData(
    SIGNATURES.bind,
    ["bytes32", "bytes32", "address"],
    [projectId, claimId, contributor],
  );
}

export function encodeIsReviewer(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error(`not an address: ${address}`);
  return encodeFunctionData(SIGNATURES.reviewer, ["address"], [address]);
}

function assertWord(value: string, what: string): void {
  if (!WORD_RE.test(value))
    throw new Error(`${what} must be 0x + 64 hex characters`);
}

/** An id as the contracts see it: a 0x word as it is, or a short label as Solidity's `bytes32("label")`. */
export function idWord(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("0x")) {
    assertWord(trimmed, "id");
    return trimmed.toLowerCase();
  }
  const bytes = utf8ToBytes(trimmed);
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error("an id is a label of 1 to 32 bytes, or a 0x + 64 hex word");
  }
  return `0x${bytesToHex(bytes).padEnd(64, "0")}`;
}

/** A readable label back out of an id word when it is one (`bytes32("docs")`), else the shortened word. */
export function idLabel(word: string): string {
  const hex = word.replace(/^0x/, "");
  const bytes = hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [];
  const end = bytes.findIndex((b) => b === 0);
  const text = bytes.slice(0, end === -1 ? bytes.length : end);
  const rest = end === -1 ? [] : bytes.slice(end);
  const printable =
    text.length > 0 &&
    text.every((b) => b >= 0x20 && b < 0x7f) &&
    rest.every((b) => b === 0);
  return printable
    ? String.fromCharCode(...text)
    : `${word.slice(0, 10)}…${word.slice(-4)}`;
}

// ---- reads, decoded --------------------------------------------------------------------------

const wordsOf = (hex: string): bigint[] => {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64)
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return out;
};
const addressOf = (word: bigint): string =>
  `0x${word.toString(16).padStart(40, "0")}`;
const bytes32Of = (word: bigint): string =>
  `0x${word.toString(16).padStart(64, "0")}`;

export const CLAIM_STATUSES = [
  "Open",
  "Approved",
  "Rejected",
  "Frozen",
  "Paid",
  "Recovered",
  "Expired",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface ClaimRecord {
  contributor: string;
  amount: bigint;
  stake: bigint;
  status: ClaimStatus;
  evidenceHash: string;
  checkHash: string;
  expiresAt: number;
  releasedAt: number;
}

/** `ClaimStake.claims(bytes32)`: eight words. Null for a claim that does not exist or a reply that is not one. */
export function decodeClaim(hex: string): ClaimRecord | null {
  const w = wordsOf(hex);
  if (w.length < 8 || w[0] === 0n) return null;
  const status = CLAIM_STATUSES[Number(w[3])];
  if (!status) return null;
  return {
    contributor: addressOf(w[0]),
    amount: w[1],
    stake: w[2],
    status,
    evidenceHash: bytes32Of(w[4]),
    checkHash: bytes32Of(w[5]),
    expiresAt: Number(w[6]),
    releasedAt: Number(w[7]),
  };
}

export interface ProjectRecord {
  manager: string;
  budget: bigint;
  reserved: bigint;
  expiresAt: number;
  checkHash: string;
  shareBudget: bigint;
  sharesAwarded: bigint;
}

/** `TreasuryMandate.projects(bytes32)`: seven words. */
export function decodeProject(hex: string): ProjectRecord | null {
  const w = wordsOf(hex);
  if (w.length < 7 || w[0] === 0n) return null;
  return {
    manager: addressOf(w[0]),
    budget: w[1],
    reserved: w[2],
    expiresAt: Number(w[3]),
    checkHash: bytes32Of(w[4]),
    shareBudget: w[5],
    sharesAwarded: w[6],
  };
}

export const decodeWord = (hex: string): bigint => wordsOf(hex)[0] ?? 0n;
export const decodeAddress = (hex: string): string =>
  addressOf(decodeWord(hex));
export const decodeBool = (hex: string): boolean => decodeWord(hex) !== 0n;

interface LogLike {
  topics?: unknown;
  data?: unknown;
}

function logParts(
  log: LogLike,
  topic: string,
  topics: number,
): { t: string[]; w: bigint[] } | null {
  const t = Array.isArray(log.topics) ? (log.topics as unknown[]) : [];
  if (
    t.length !== topics ||
    t[0] !== topic ||
    t.some((x) => typeof x !== "string")
  )
    return null;
  if (typeof log.data !== "string") return null;
  return { t: t as string[], w: wordsOf(log.data) };
}

export interface MandateCreated {
  dao: string;
  mandate: string;
  currency: string;
  budget: bigint;
  perProjectCap: bigint;
  shareBudget: bigint;
  perProjectShareCap: bigint;
}

export function decodeMandateCreated(log: LogLike): MandateCreated | null {
  const p = logParts(log, TOPIC_MANDATE_CREATED, 3);
  if (!p || p.w.length < 5) return null;
  return {
    dao: addressOf(BigInt(p.t[1])),
    mandate: addressOf(BigInt(p.t[2])),
    currency: addressOf(p.w[0]),
    budget: p.w[1],
    perProjectCap: p.w[2],
    shareBudget: p.w[3],
    perProjectShareCap: p.w[4],
  };
}

export interface ProjectApproved {
  projectId: string;
  manager: string;
  amount: bigint;
  shareAmount: bigint;
  expiresAt: number;
  checkHash: string;
}

export function decodeProjectApproved(log: LogLike): ProjectApproved | null {
  const p = logParts(log, TOPIC_PROJECT_APPROVED, 3);
  if (!p || p.w.length < 4) return null;
  return {
    projectId: bytes32Of(BigInt(p.t[1])),
    manager: addressOf(BigInt(p.t[2])),
    amount: p.w[0],
    shareAmount: p.w[1],
    expiresAt: Number(p.w[2]),
    checkHash: bytes32Of(p.w[3]),
  };
}

export interface ClaimSubmitted {
  claimId: string;
  contributor: string;
  amount: bigint;
  stake: bigint;
  evidenceHash: string;
}

export function decodeClaimSubmitted(log: LogLike): ClaimSubmitted | null {
  const p = logParts(log, TOPIC_CLAIM_SUBMITTED, 2);
  if (!p || p.w.length < 4) return null;
  return {
    claimId: bytes32Of(BigInt(p.t[1])),
    contributor: addressOf(p.w[0]),
    amount: p.w[1],
    stake: p.w[2],
    evidenceHash: bytes32Of(p.w[3]),
  };
}

// ---- what to do next -----------------------------------------------------------------------

export interface ClaimView {
  id: string;
  record: ClaimRecord;
  /** The project it is bound to, or null while it is not. */
  project: string | null;
  approvals: number;
  objections: number;
  quorum: number;
  sharesAwarded: boolean;
}

/** What happens to a claim next, and who does it. */
export type NextStep =
  | { kind: "bind"; who: "manager"; text: string }
  | { kind: "review"; who: "reviewer"; text: string }
  | { kind: "settle"; who: "anyone"; text: string }
  | { kind: "payout"; who: "contributor"; text: string }
  | { kind: "award"; who: "dao"; text: string }
  | { kind: "none"; who: "nobody"; text: string };

/** One sentence per state, in words a person can act on. */
export function nextStep(
  claim: ClaimView,
  now: number,
  challengeWindow: number,
): NextStep {
  const { record } = claim;
  switch (record.status) {
    case "Open":
      if (claim.project === null) {
        return {
          kind: "bind",
          who: "manager",
          text: "Waiting for a project manager to take this claim on.",
        };
      }
      if (claim.quorum !== 0 && claim.approvals >= claim.quorum) {
        return {
          kind: "settle",
          who: "anyone",
          text: "Enough reviewers approved it. Anyone can finish it.",
        };
      }
      return {
        kind: "review",
        who: "reviewer",
        text: `Waiting for reviewers: ${claim.approvals} of ${claim.quorum} approvals.`,
      };
    case "Approved": {
      const open = record.releasedAt + challengeWindow;
      return now >= open
        ? {
            kind: "payout",
            who: "contributor",
            text: "Approved. The contributor can take it now.",
          }
        : {
            kind: "none",
            who: "nobody",
            text: "Approved. It can be taken once the challenge window ends.",
          };
    }
    case "Paid":
      if (claim.sharesAwarded)
        return {
          kind: "none",
          who: "nobody",
          text: "Done. Shares were awarded for this work.",
        };
      return claim.project === null
        ? {
            kind: "none",
            who: "nobody",
            text: "Paid, but not part of a project, so it cannot earn Shares.",
          }
        : {
            kind: "award",
            who: "dao",
            text: "Approved and paid. The DAO can vote to award Shares for it.",
          };
    case "Frozen":
      return {
        kind: "none",
        who: "nobody",
        text: "Frozen. The DAO decides what happens to it.",
      };
    default:
      return {
        kind: "none",
        who: "nobody",
        text: "Closed. Nothing more happens.",
      };
  }
}
