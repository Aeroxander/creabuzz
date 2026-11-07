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
  approvalsAtSubmit: "approvalsAtSubmit(bytes32)",
  objectionsAtSubmit: "objectionsAtSubmit(bytes32)",
  quorum: "quorum()",
  reviewer: "verifiers(address)",
  attest: "attest(bytes32,bool)",
  submitClaim: "submitClaim(bytes32,uint256,uint256,bytes32)",
  setCheck: "setCheck(bytes32,bytes32)",
  settle: "settle(bytes32)",
  expire: "expire(bytes32)",
  payout: "payout(bytes32)",
  bind: "fundMilestone(bytes32,bytes32,address)",
  bindMilestone: "bindMilestone(bytes32)",
  policy: "votingWeight()",
  factory: "mandateFactory()",
  milestoneMandate: "milestoneMandate(address)",
  bondToken: "bondToken()",
  minBond: "minBond()",
  bond: "bond(uint256)",
  requestUnbond: "requestUnbond(uint256)",
  withdraw: "withdraw()",
  unbonds: "unbonds(address)",
  currencyApprove: "approve(address,uint256)",
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
export const TOPIC_VERIFIER_ACCEPTED = topicOf(
  "VerifierAccepted(address,uint256)",
);

/** The topic0 of an event: keccak256 of its canonical signature. */
export function topicOf(signature: string): string {
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

/** A team member files their own milestone claim into the DAO's milestone panel: no project and no manager. */
export function encodeBindMilestone(claimId: string): string {
  assertWord(claimId, "claim id");
  return encodeFunctionData(SIGNATURES.bindMilestone, ["bytes32"], [claimId]);
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

/** A claim that asks for no currency and stakes none: it asks to be recognised, not paid. */
export function encodeSubmitRecognitionClaim(
  claimId: string,
  evidenceHash: string,
): string {
  assertWord(claimId, "claim id");
  assertWord(evidenceHash, "evidence hash");
  return encodeFunctionData(
    SIGNATURES.submitClaim,
    ["bytes32", "uint256", "uint256", "bytes32"],
    [claimId, 0n, 0n, evidenceHash],
  );
}

/**
 * A claim that asks to be paid `amount` of the work budget's currency, with an optional `stake` the contributor puts up
 * (it comes back with the payout, and is lost if the reviewers object). The currency approval for a stake is the
 * caller's to send first.
 */
export function encodeSubmitPaidClaim(
  claimId: string,
  amount: bigint,
  stake: bigint,
  evidenceHash: string,
): string {
  assertWord(claimId, "claim id");
  assertWord(evidenceHash, "evidence hash");
  if (amount < 0n || stake < 0n) throw new Error("amounts cannot be negative");
  return encodeFunctionData(
    SIGNATURES.submitClaim,
    ["bytes32", "uint256", "uint256", "bytes32"],
    [claimId, amount, stake, evidenceHash],
  );
}

export function encodeSetCheck(claimId: string, checkHash: string): string {
  assertWord(claimId, "claim id");
  assertWord(checkHash, "check hash");
  return encodeFunctionData(
    SIGNATURES.setCheck,
    ["bytes32", "bytes32"],
    [claimId, checkHash],
  );
}

/** The hash of some words: how an acceptance check or a piece of evidence is committed to. */
export function hashText(text: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(text.trim())))}`;
}

export const ZERO_WORD = `0x${"0".repeat(64)}`;

/** `bond(uint256)` on the VerifierSet: a reviewer posts `amount` of the claim currency (approve it to the set first). */
export function encodeBond(amount: bigint): string {
  if (amount <= 0n) throw new Error("a bond must be more than zero");
  return encodeFunctionData(SIGNATURES.bond, ["uint256"], [amount]);
}

/**
 * `requestUnbond(uint256)` on the VerifierSet: ask for `amount` of the bond back. It stops counting toward judging at
 * once and stays slashable until the delay has passed.
 */
export function encodeRequestUnbond(amount: bigint): string {
  if (amount <= 0n) throw new Error("ask for more than zero");
  return encodeFunctionData(SIGNATURES.requestUnbond, ["uint256"], [amount]);
}

/** `withdraw()` on the VerifierSet: take back what was asked for, once the delay has passed. */
export function encodeWithdraw(): string {
  return selectorOf(SIGNATURES.withdraw);
}

/** What `unbonds(address)` says: the bond asked back and when it can be taken (zero when nothing is pending). */
export function decodeUnbond(hex: string): {
  amount: bigint;
  availableAt: number;
} {
  const w = wordsOf(hex);
  return { amount: w[0] ?? 0n, availableAt: Number(w[1] ?? 0n) };
}

/** The ERC-20 `approve` a reviewer sends before posting a bond. */
export function encodeCurrencyApprove(spender: string, amount: bigint): string {
  if (!ADDRESS_RE.test(spender)) throw new Error(`not an address: ${spender}`);
  if (amount < 0n) throw new Error("amounts cannot be negative");
  return encodeFunctionData(
    SIGNATURES.currencyApprove,
    ["address", "uint256"],
    [spender, amount],
  );
}

/** What `verifiers(address)` says about one reviewer: whether they are on the panel, and the bond they hold. */
export function decodeVerifier(hex: string): {
  active: boolean;
  stake: bigint;
} {
  const w = wordsOf(hex);
  return { active: (w[0] ?? 0n) !== 0n, stake: w[1] ?? 0n };
}

/** How much more bond a reviewer must post to judge claims: zero when no bond is asked or theirs is enough. */
export function bondShortfall(
  bond: { minBond: bigint } | null,
  stake: bigint,
): bigint {
  if (!bond || stake >= bond.minBond) return 0n;
  return bond.minBond - stake;
}

export function encodeUnbonds(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error(`not an address: ${address}`);
  return encodeFunctionData(SIGNATURES.unbonds, ["address"], [address]);
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

const CLAIM_STATUSES = [
  "Open",
  "Approved",
  "Rejected",
  "Frozen",
  "Paid",
  "Recovered",
  "Expired",
  "Retired",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * A claim's status as people read it. The contract calls a claim `Paid` once its challenge window has passed and it
 * was taken, whether or not it asked for money; one that asked for none moved no money, so it reads "Finished".
 */
export function claimStatusLabel(record: {
  status: ClaimStatus;
  amount: bigint;
}): string {
  return record.status === "Paid" && record.amount === 0n
    ? "Finished"
    : record.status;
}

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
  /**
   * Approvals and objections that count toward `ClaimStake.settle`: only those made after the claim was submitted (the
   * contract keeps the counts at submission and subtracts them).
   */
  approvals: number;
  objections: number;
  /**
   * Verdicts given on this claim's id before it was submitted. They do not count toward a verdict, and the reviewers
   * who gave them cannot answer again. Absent when there were none.
   */
  earlyVerdicts?: number;
  quorum: number;
  sharesAwarded: boolean;
  /**
   * How many reviewers are on the panel, when the panel could be read: with it, a split that nobody left can break is
   * told apart from one still waiting on someone. Null or absent when it is not known.
   */
  panel?: number | null;
}

/** What happens to a claim next, and who does it. */
export type NextStep =
  | { kind: "bind"; who: "manager" | "contributor"; text: string }
  | { kind: "review"; who: "reviewer"; text: string }
  /** Enough reviewers agreed one way: anyone can settle it, which approves it or turns it down. */
  | {
      kind: "settle";
      who: "anyone";
      verdict: "approved" | "turned-down";
      text: string;
    }
  /**
   * No work area that is open now uses its words, so no manager can accept it: its contributor can put a work area's
   * words on it (`setCheck`, while no area holds it and nobody has reviewed it).
   */
  | { kind: "words"; who: "contributor"; text: string }
  /** Nobody settled it before its deadline: anyone can close it as lapsed, which returns any deposit. */
  | { kind: "expire"; who: "anyone"; text: string }
  /** The reviewers are split and nobody is left to break it: it waits for its deadline (`lapsesAt`, unix seconds). */
  | { kind: "stuck"; who: "nobody"; text: string; lapsesAt: number }
  | { kind: "payout"; who: "contributor"; text: string }
  | { kind: "award"; who: "dao"; text: string }
  /**
   * Nothing to do now. An approved claim in its wait carries `readyAt` (unix seconds): when the wait ends and its
   * contributor can take it (mark it finished, or take the payment), so the pages can name the date.
   */
  | { kind: "none"; who: "nobody"; text: string; readyAt?: number };

/**
 * Whether a split vote can still be decided: with `panel` reviewers on the panel, those who have not answered could
 * still bring either side to the quorum. Unknown panel sizes are never called stuck.
 */
export function cannotReachVerdict(
  claim: Pick<
    ClaimView,
    "approvals" | "objections" | "quorum" | "panel" | "earlyVerdicts"
  >,
): boolean {
  const panel = claim.panel;
  if (panel === null || panel === undefined || panel <= 0) return false;
  if (claim.quorum <= 0) return false;
  // A reviewer who answered before the claim was submitted has used their one answer on a verdict that does not count.
  const left = Math.max(
    0,
    panel - claim.approvals - claim.objections - (claim.earlyVerdicts ?? 0),
  );
  return (
    claim.approvals + left < claim.quorum &&
    claim.objections + left < claim.quorum
  );
}

/**
 * Whether anyone can close an open claim as lapsed now: what `ClaimStake.expire` checks (still open, and its deadline is
 * past: `block.timestamp > expiresAt`).
 */
export function canExpire(
  record: Pick<ClaimRecord, "status" | "expiresAt">,
  now: number,
): boolean {
  return (
    record.status === "Open" && record.expiresAt > 0 && now > record.expiresAt
  );
}

/** "1 of 2 approvals", and how many turned it down when any did. */
function reviewCount(claim: ClaimView): string {
  const approvals = `${claim.approvals} of ${claim.quorum} approvals`;
  return claim.objections > 0
    ? `${approvals}, ${claim.objections} turned it down`
    : approvals;
}

/**
 * Whether `wallet` can accept `claim` for review in `project` right now: what `TreasuryMandate.fundMilestone` checks
 * (the project's manager, an open budget and project neither past its end, an open claim no project holds yet, the
 * same words, and money left for a payment it asks for), so the pages offer the step only where it can succeed.
 */
export function canAcceptClaim(input: {
  wallet: string | null;
  mandate: { closed: boolean; expiresAt: number };
  project: { record: ProjectRecord };
  claim: Pick<ClaimView, "record" | "project">;
  now: number;
}): boolean {
  const { wallet, mandate, project, claim, now } = input;
  const { record } = project;
  return (
    wallet !== null &&
    record.manager.toLowerCase() === wallet.toLowerCase() &&
    !mandate.closed &&
    now < mandate.expiresAt &&
    now < record.expiresAt &&
    claim.project === null &&
    claim.record.status === "Open" &&
    claim.record.checkHash.toLowerCase() === record.checkHash.toLowerCase() &&
    claim.record.amount <= record.budget - record.reserved
  );
}

/** One sentence per state, in words a person can act on. */
export function nextStep(
  claim: ClaimView,
  now: number,
  challengeWindow: number,
  /** The claim is in the DAO's milestone panel, where its team member files it themselves. */
  milestonePanel = false,
): NextStep {
  const { record } = claim;
  switch (record.status) {
    case "Open": {
      // What the contract's `settle` checks: enough approvals approves it, enough objections turns it down. It does not
      // look at the deadline, so a claim that reached a verdict can be settled even after it.
      if (claim.project !== null && claim.quorum !== 0) {
        if (claim.approvals >= claim.quorum) {
          return {
            kind: "settle",
            who: "anyone",
            verdict: "approved",
            text: "Enough reviewers approved it. Anyone can finish it.",
          };
        }
        if (claim.objections >= claim.quorum) {
          return {
            kind: "settle",
            who: "anyone",
            verdict: "turned-down",
            text: "Enough reviewers turned it down. Anyone can close it as turned down.",
          };
        }
      }
      // Past its deadline anyone can close it as lapsed (`expire`, which returns any deposit). The reviewers can still
      // answer until someone does, so a claim that can still reach a verdict keeps its review step, and the pages offer
      // the close beside it (`canExpire`).
      const lapsed = canExpire(record, now);
      const lapsedStep: NextStep = {
        kind: "expire",
        who: "anyone",
        text:
          record.stake > 0n
            ? "Nobody finished its review in time, so it lapsed. Anyone can close it, and the deposit goes back to the contributor."
            : "Nobody finished its review in time, so it lapsed. Anyone can close it.",
      };
      if (claim.project === null && lapsed) return lapsedStep;
      if (claim.project === null && milestonePanel) {
        return {
          kind: "bind",
          who: "contributor",
          text: "Filed, but not yet submitted to the milestone panel. The team member who filed it submits it.",
        };
      }
      if (claim.project === null) {
        return {
          kind: "bind",
          who: "manager",
          text: "Waiting for a work area's manager to accept it for review.",
        };
      }
      if (cannotReachVerdict(claim)) {
        return lapsed
          ? lapsedStep
          : {
              kind: "stuck",
              who: "nobody",
              lapsesAt: record.expiresAt,
              text: `The reviewers are split (${reviewCount(claim)}) and nobody is left to decide. It cannot be approved or turned down; once its deadline passes, anyone can close it.`,
            };
      }
      return {
        kind: "review",
        who: "reviewer",
        text: lapsed
          ? `Its deadline has passed (${reviewCount(claim)}). Reviewers can still answer, or anyone can close it as lapsed.`
          : `Waiting for reviewers: ${reviewCount(claim)}.`,
      };
    }
    case "Approved": {
      const open = record.releasedAt + challengeWindow;
      // A claim that asked for no money is still taken once, to finish it: that is what makes it awardable.
      const money = record.amount > 0n;
      return now >= open
        ? {
            kind: "payout",
            who: "contributor",
            text: money
              ? "Approved. The contributor can take the payment now."
              : "Approved and ready to mark finished. The contributor can mark it finished now, so Shareholders can vote on an award.",
          }
        : {
            kind: "none",
            who: "nobody",
            readyAt: open,
            text: money
              ? "Approved. The payment can be taken once the challenge window ends."
              : "Approved. It can be marked finished once the challenge window ends.",
          };
    }
    case "Paid":
      if (milestonePanel)
        return {
          kind: "none",
          who: "nobody",
          text: "Approved and past the waiting period. The Shares this milestone covers can be unlocked.",
        };
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
            text: `${record.amount > 0n ? "Paid" : "Finished"}, but not part of a work area, so it cannot earn Shares.`,
          }
        : {
            kind: "award",
            who: "dao",
            text: `${record.amount > 0n ? "Approved and paid" : "Finished; no money was asked for"}. Shareholders can vote to award Shares for it.`,
          };
    case "Frozen":
      return {
        kind: "none",
        who: "nobody",
        text: "Frozen. The DAO decides what happens to it.",
      };
    case "Rejected":
      return {
        kind: "none",
        who: "nobody",
        // The contract zeroes the stake when it settles, so whether there was a deposit is not readable here.
        text: "Turned down by the reviewers. To try again, fix the work and submit it under a new name.",
      };
    case "Retired":
      return {
        kind: "none",
        who: "nobody",
        text: "Replaced by a new submission. This attempt cannot earn another reward or receive more reviews.",
      };
    case "Expired":
      return {
        kind: "none",
        who: "nobody",
        text: "Lapsed: nobody finished its review in time. Any deposit went back to the contributor.",
      };
    default:
      return {
        kind: "none",
        who: "nobody",
        text: "Closed. Nothing more happens.",
      };
  }
}

/**
 * {@link nextStep}, told about the budget's work areas: a claim waiting for a manager whose words no open work area uses
 * waits on nobody, so it says that instead (the second half of the "Not sure yet" check the submit form makes). While the
 * budget has no open work area at all it still waits for one, and keeps the manager's step.
 */
export function claimStep(
  claim: ClaimView,
  mandate: {
    challengeWindow: number;
    isMilestonePanel: boolean;
    closed: boolean;
    expiresAt: number;
    projects: readonly {
      record: Pick<ProjectRecord, "expiresAt" | "checkHash">;
    }[];
  },
  now: number,
): NextStep {
  const step = nextStep(
    claim,
    now,
    mandate.challengeWindow,
    mandate.isMilestonePanel,
  );
  if (step.kind !== "bind" || step.who !== "manager") return step;
  // Once a reviewer has answered, the words are locked (ClaimStake.setCheck), so a different step would mislead.
  if (claim.approvals + claim.objections + (claim.earlyVerdicts ?? 0) > 0)
    return step;
  if (mandate.closed || now >= mandate.expiresAt) return step;
  const open = mandate.projects.filter((p) => now < p.record.expiresAt);
  if (open.length === 0) return step;
  const words = claim.record.checkHash.toLowerCase();
  if (open.some((p) => p.record.checkHash.toLowerCase() === words)) return step;
  return {
    kind: "words",
    who: "contributor",
    text: "Its words match no open work area, so no manager can accept it for review. Its contributor can submit it again under the same name and evidence, with a work area's words.",
  };
}
