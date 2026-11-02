/**
 * One attempt of an agreed submission, kept in this browser from the moment
 * its claim id goes to the chain until its evidence is published — the
 * milestone-draft pattern (`claim-draft.ts`), applied to the agreed lane.
 *
 * The chain only holds fingerprints. Without the exact text a claim cannot be
 * approved, and the exact attempt id (a claim id hashed from
 * `keccak(agreementId, attempt, nonce)`) is only readable to the browser that
 * picked the nonce. So the whole attempt is kept **before** the wallet is
 * asked, under a scope that names the server, the signed-in account, the
 * wallet, the chain, the mandate and the agreement: a retry sends the same
 * claim id again (never a second claim for one attempt), and one person's copy
 * never fills in another's form — an account, wallet or chain change reads
 * nothing back.
 *
 * Pure and alias-free: `agreed-submission.test.mjs` drives it under `node --test`.
 */

import {
  attemptClaimId,
  buildAgreedSubmissionBatch,
  encodeBindSubmission,
  splitHashOf,
  type AgreementTerms,
} from "@creaton/core/launchpad/agreements.ts";

export const AGREED_DRAFT_PREFIX = "buzz.launchpad.agreed-submission:";

/** One attempt's text, kept until its evidence is published. */
export interface AgreedSubmissionDraft {
  agreementId: string;
  /** The mandate the agreement lives under, lower case. */
  mandate: string;
  /** The chain the attempt is on (the launch record's chain id, as text). */
  chainId: string;
  /**
   * Which attempt this is: the record's `attempts` + 1 when the attempt was
   * planned; corrections ride the next number, and a retry never changes it.
   */
  attempt: number;
  /** The one-shot random number the claim id was hashed from. Reused on every retry. */
  nonce: number;
  claimId: string;
  /** Where the work is, exactly as its fingerprint went to the chain. */
  artifact: string;
  /** What the submitter checked against the agreed criteria words. */
  met: string;
  notMet: string;
  /** The agreed criteria words the claim states, exactly as they were set. */
  criteriaWords: string;
  savedAt: number;
  /** Set once the chain steps landed but the evidence could not be published. */
  pendingPublish?: boolean;
}

/** What a caller hands to {@link saveAgreedDraft}: the kept moment is the writer's, never the caller's. */
type AgreedDraftInput = Omit<AgreedSubmissionDraft, "savedAt"> & {
  savedAt?: number;
};

export type AgreedDraftScope = {
  /** The server this page talks to. */
  server: string;
  /** The signed-in account. */
  account: string;
  /** The wallet that submits. */
  wallet: string;
  /** The chain the mandate is on. */
  chainId: string;
  /** The mandate the agreement lives under. */
  mandate: string;
  /** The agreement the attempt belongs to. */
  agreementId: string;
};

/** The key one attempt is kept under: every scope part, lower case, in order. */
export function agreedDraftKey(scope: AgreedDraftScope): string {
  return `${AGREED_DRAFT_PREFIX}${[
    scope.server,
    scope.account,
    scope.wallet,
    scope.chainId,
    scope.mandate,
    scope.agreementId,
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|")}`;
}

const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem" | "getItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;

function asDraft(value: unknown): AgreedSubmissionDraft | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === "string" ? (raw[key] as string) : null;
  const agreementId = text("agreementId");
  const mandate = text("mandate");
  const chainId = text("chainId");
  const claimId = text("claimId");
  const artifact = text("artifact");
  const met = text("met");
  const notMet = text("notMet");
  const criteriaWords = text("criteriaWords");
  if (
    !agreementId ||
    !HEX_WORD.test(agreementId) ||
    !mandate ||
    !chainId ||
    !claimId ||
    !HEX_WORD.test(claimId) ||
    !met ||
    !criteriaWords
  ) {
    return null;
  }
  const attempt = typeof raw.attempt === "number" ? raw.attempt : null;
  const nonce = typeof raw.nonce === "number" ? raw.nonce : null;
  if (
    attempt === null ||
    nonce === null ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    nonce < 0 ||
    !Number.isSafeInteger(nonce)
  ) {
    return null;
  }
  return {
    agreementId,
    mandate,
    chainId,
    attempt,
    nonce,
    claimId,
    artifact: artifact ?? "",
    met,
    notMet: notMet ?? "",
    criteriaWords,
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    ...(raw.pendingPublish === true ? { pendingPublish: true } : {}),
  };
}

/** The kept attempt, or null when there is none or it is not well formed. */
export function loadAgreedDraft(
  key: string,
  storage: ReadStorage | null = safeStorage(),
): AgreedSubmissionDraft | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    return asDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Keep the copy. True only when it is really kept: the write did not fail and
 * reading it back gives the same attempt. Nothing is sent when this is false.
 */
export function saveAgreedDraft(
  key: string,
  draft: AgreedDraftInput,
  storage: WriteStorage | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    const raw = JSON.stringify({ ...draft, savedAt: Date.now() });
    storage.setItem(key, raw);
    return JSON.parse(storage.getItem(key) ?? "null") !== null;
  } catch {
    return false;
  }
}

/** Forget the copy, once its evidence is published. */
export function clearAgreedDraft(
  key: string,
  storage: Pick<Storage, "removeItem"> | null = safeStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

/**
 * The attempt this browser still has to publish for one agreement, if any: its
 * chain steps landed but its evidence did not reach the server. It stays
 * visible across reloads, so the retry is never lost.
 */
export function pendingPublishDraft(
  scope: AgreedDraftScope,
  storage: ReadStorage | null | undefined,
): AgreedSubmissionDraft | null {
  const store = storage === undefined ? safeStorage() : storage;
  if (!store) return null;
  const draft = loadAgreedDraft(agreedDraftKey(scope), store);
  return draft?.pendingPublish === true ? draft : null;
}

/**
 * The agreements a browser already keeps an attempt for, under one account /
 * wallet / chain scope: the lane read asks the chain about these ids too, so
 * an offer that fell outside the bounded discovery is still listed for the
 * person who holds it. Read back demand-side per scope — nothing from another
 * scope (another wallet, account, chain) comes along.
 */
export function listedDrafts(
  storage: ReadStorage | null | undefined,
  scope: { server: string; account: string; wallet: string; chainId: string },
): { key: string; mandate: string; agreementId: string; claimId: string }[] {
  const store = storage === undefined ? safeStorage() : storage;
  if (!store) return [];
  const prefix = `${AGREED_DRAFT_PREFIX}${[
    scope.server,
    scope.account,
    scope.wallet,
    scope.chainId,
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|")}|`;
  const out: {
    key: string;
    mandate: string;
    agreementId: string;
    claimId: string;
  }[] = [];
  for (const key of storageKeys(store)) {
    if (!key.startsWith(prefix)) continue;
    const draft = loadAgreedDraft(key, store);
    if (draft) {
      out.push({
        key,
        mandate: draft.mandate,
        agreementId: draft.agreementId,
        claimId: draft.claimId,
      });
    }
  }
  return out;
}

function storageKeys(storage: ReadStorage): string[] {
  const withKeys = storage as Partial<Pick<Storage, "key" | "length">>;
  const length = typeof withKeys.length === "number" ? withKeys.length : 0;
  const keys: string[] = [];
  if (typeof withKeys.key === "function") {
    for (let index = 0; index < length; index += 1) {
      const key = withKeys.key(index);
      if (key) keys.push(key);
    }
    return keys;
  }
  // Exotic wrappers without `key`: nothing to enumerate; the kept copy is
  // still found by its exact key. `listedDrafts` degrades to that.
  return [];
}

// ── the attempt's chain steps, planned from what is actually there ──────────

/** What one attempt already has on chain, read by its caller (`claims(claimId)`). */
export type AttemptRecord = {
  contributor: string;
  evidenceHash: string;
  checkHash: string;
} | null;

export interface AttemptPlan {
  /**
   * The beneficiary's steps, in the mandate's own order: the escrow claim
   * (no currency ask), the agreed check, then the agreement's own
   * `bindSubmission`. Only the ones still missing are planned.
   */
  calls: { to: string; data: string }[];
  /** Why nothing was planned; the only case is a conflict nobody should paper over. */
  problem: string | null;
}

/**
 * The beneficiary's remaining calls for one attempt: the claim's submission
 * (no currency ask — the agreed reward is Shares) if the claim is not on the
 * chain yet, then the agreed check if it is not stated, then the binding that
 * makes the attempt the agreement's own. Same claim id on every retry; never a
 * second claim, never a second reward.
 */
export function planBeneficiaryCalls(input: {
  claims: string;
  mandate: string;
  agreementId: string;
  claimId: string;
  evidenceHash: string;
  criteriaHash: string;
  /** What `claims(claimId)` answered for this exact id. */
  record: AttemptRecord;
  /** The chain's `agreementOfClaim(claimId)` names this agreement: the bind landed. */
  bound: boolean;
}): AttemptPlan {
  const batch = buildAgreedSubmissionBatch({
    claims: input.claims,
    mandate: input.mandate,
    agreementId: input.agreementId,
    claimId: input.claimId,
    evidenceHash: input.evidenceHash,
    criteriaHash: input.criteriaHash,
  });
  const calls: { to: string; data: string }[] = [];
  const record = input.record;
  if (record === null) {
    calls.push(batch[0]);
  } else {
    // A claim id is one-shot: what is already there must be this attempt's
    // evidence. Anything else is a conflict, said before the wallet is asked.
    if (
      record.evidenceHash?.toLowerCase() !== input.evidenceHash.toLowerCase()
    ) {
      return {
        calls: [],
        problem:
          "A submission already exists under this attempt with different text. This award keeps that attempt; take a new agreement for different work.",
      };
    }
  }
  if (
    !record ||
    record.checkHash.toLowerCase() !== input.criteriaHash.toLowerCase()
  ) {
    calls.push(batch[1]);
  }
  // The binding is the last step, and only until it lands: a retry after a
  // half-sent batch must never bind a second time.
  if (!input.bound) calls.push(batch[2]);
  return { calls, problem: null };
}

/**
 * The manager's bind step for a submitted attempt: `bindSubmission` at the
 * mandate. Nothing is sent when the record already names this attempt.
 */
export function planManagerBind(input: {
  mandate: string;
  agreementId: string;
  claimId: string;
  /** The agreement record's own `claimId` (what the record is bound to now). */
  boundTo: string | null;
}): { call: { to: string; data: string } | null } {
  if (
    input.boundTo !== null &&
    input.boundTo?.toLowerCase() === input.claimId.toLowerCase()
  ) {
    return { call: null };
  }
  return {
    call: {
      to: input.mandate,
      data: encodeBindSubmission(input.agreementId, input.claimId),
    },
  };
}

/**
 * A claim in the escrow that could ride this agreement: submitted by the
 * beneficiary, asking no currency (the agreed reward is Shares), gathered to
 * no work area yet, still open, and stating the agreed check. Exactly what
 * `bindSubmission` accepts, read from the work snapshot the page already has.
 */
export function bindCandidates(input: {
  row: { terms: AgreementTerms };
  claims: readonly {
    id: string;
    project: string | null;
    record: {
      contributor: string;
      amount: bigint;
      status: string;
      checkHash: string;
    };
  }[];
}): { id: string }[] {
  const beneficiary = input.row.terms.beneficiary.toLowerCase();
  const criteria = input.row.terms.criteriaHash.toLowerCase();
  const current = input.row.terms.claimId?.toLowerCase() ?? null;
  return input.claims
    .filter((claim) => !current || claim.id.toLowerCase() !== current)
    .filter(
      (claim) =>
        claim.project === null &&
        claim.record.status === "Open" &&
        claim.record.amount === 0n &&
        claim.record.contributor.toLowerCase() === beneficiary &&
        claim.record.checkHash.toLowerCase() === criteria,
    )
    .map((claim) => ({ id: claim.id }));
}

// ── typed amounts and hashes ────────────────────────────────────────────────

/** The random 0..2^31 nonce one attempt keeps. */
export function randomNonce(): number {
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return bytes[0] % (1 << 30);
}

/** The attempt's claim id from its agreement, attempt and one-shot nonce. */
export function attemptIdOf(input: {
  agreementId: string;
  attempt: number;
  nonce: number;
}): string {
  return attemptClaimId({
    agreementId: input.agreementId,
    attempt: input.attempt,
    nonce: input.nonce,
  });
}

/** The split hash a proposal commits, for display beside the terms. */
export const decideSplitHash = splitHashOf;

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
