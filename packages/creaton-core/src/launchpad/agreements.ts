/**
 * The agreed-contribution rewards lane — terms, exact call bytes and the
 * next step each party takes, read from the mandate's own records.
 *
 * Chain surface (the contract is the only source of truth; this module
 * encodes it, never re-models it) — the deployed `TreasuryMandate`:
 *
 * - `AGREEMENTS_VERSION()` → `uint16`, the interface marker (currently 1). A
 *   REVERT on that read is a legacy deployment or a failed RPC — never read
 *   as "supports it, with nothing in it"; the read side classifies
 *   (`agreementsRead.ts`).
 * - `agreements(bytes32)` → a 13-field tuple in the record's own field order:
 *   `(projectId, beneficiary, shares, criteriaHash, policyRef, acceptedAt,
 *   reviewPeriod, workDeadline, revisionDeadline, claimId, terminalKind,
 *   attempts, splitHash)`.
 * - `agreementId = keccak256(abi.encode(projectId, slot))` — an id is bound to
 *   one deliverable slot per work area, so one offer cannot reach two people.
 * - `proposeAgreement(...)`, `acceptAgreement(...)`, `bindSubmission(...)`,
 *   `releaseAgreement(...)` are the mandate's own calls; `settleAgreement` is
 *   the DAO's permissionless one-time mint path (`settleAgreement(mandate,
 *   agreementId)` on the DAO, which returns nothing to its caller — the
 *   recipients and the exact quantity are derived from the record). Everything
 *   here returns ordered unsigned call bytes; sending, funding and signing
 *   stay with the wallet layers. Nothing in this module moves money.
 *
 * Honey words this adapter keeps straight everywhere it touches them:
 * `shares` is the **exact reserved quantity in uint128 token units** (fractions
 * of a Share included) — it is
 * never a cash value and never an ownership percentage; a split's donors stay
 * parts of that quantity. Quantities are `bigint` end to end: a uint128 has
 * no safe JavaScript `Number`, and none is taken.
 *
 * Alias-free with `.ts` specifiers: `agreements.test.mjs` runs it under
 * `node --test`.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";

// ── the chain's own words ─────────────────────────────────────────────────────

/** `AGREEMENTS_VERSION()` — the interface marker; a revert is never an answer. */
export const AGREEMENTS_VERSION = 1;

/** The mandate struct's own field order — pinned; do not reorder silently. */
const AGREEMENT_TUPLE = [
  "projectId",
  "beneficiary",
  "shares",
  "criteriaHash",
  "policyRef",
  "acceptedAt",
  "reviewPeriod",
  "workDeadline",
  "revisionDeadline",
  "claimId",
  "terminalKind",
  "attempts",
  "splitHash",
] as const;

/** Terminal kinds of the record, in the contract's own 0..3 order. */
export const AGREEMENT_TERMINALS = [
  "active",
  "settled",
  "cancelled",
  "expired",
] as const;
export type AgreementTerminal = (typeof AGREEMENT_TERMINALS)[number];

/** A split is part of the agreed terms: at most this many parties, exact total. */
export const AGREEMENTS_MAX_SPLIT_PARTIES = 4;
/** Split percentages are basis points; the declared parts sum to exactly this. */
export const AGREEMENTS_SPLIT_ALL = 10000;

/** `ClaimStake.Status` in the contract's own enum order. */
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

// ── selectors ────────────────────────────────────────────────────────────────

/** Canonical signatures of the calls this adapter encodes (slash-pinned). */
const AGREE_SIGNATURES = {
  version: "AGREEMENTS_VERSION()",
  agreements: "agreements(bytes32)",
  propose:
    "proposeAgreement(bytes32,address,uint128,uint64,bytes32,bytes32,bytes32)",
  accept: "acceptAgreement(bytes32,address[],uint16[])",
  bindSubmission: "bindSubmission(bytes32,bytes32)",
  release: "releaseAgreement(bytes32)",
  splits: "splits(bytes32)",
  sharesReserved: "sharesReserved(bytes32)",
  agreementOfClaim: "agreementOfClaim(bytes32)",
  /** The DAO's permissionless settlement: mint bounded to the record. */
  settle: "settleAgreement(address,bytes32)",
  /** Reviewer panel: the corrections route the mandate's bind reads. */
  requestCorrections: "requestCorrections(bytes32,bytes32)",
  correctionsCount: "correctionsCount(bytes32)",
  /** The claim escrow's submission path the offer's first attempt rides. */
  submitClaim: "submitClaim(bytes32,uint256,uint256,bytes32)",
  setCheck: "setCheck(bytes32,bytes32)",
} as const;

/** Their selectors (keccak[:4]); the tests pin these against cast-style goldens. */
export const AGREE_SELECTORS = {
  version: selectorOf(AGREE_SIGNATURES.version),
  agreements: selectorOf(AGREE_SIGNATURES.agreements),
  propose: selectorOf(AGREE_SIGNATURES.propose),
  accept: selectorOf(AGREE_SIGNATURES.accept),
  bindSubmission: selectorOf(AGREE_SIGNATURES.bindSubmission),
  release: selectorOf(AGREE_SIGNATURES.release),
  splits: selectorOf(AGREE_SIGNATURES.splits),
  sharesReserved: selectorOf(AGREE_SIGNATURES.sharesReserved),
  agreementOfClaim: selectorOf(AGREE_SIGNATURES.agreementOfClaim),
  settle: selectorOf(AGREE_SIGNATURES.settle),
  requestCorrections: selectorOf(AGREE_SIGNATURES.requestCorrections),
  correctionsCount: selectorOf(AGREE_SIGNATURES.correctionsCount),
  submitClaim: selectorOf(AGREE_SIGNATURES.submitClaim),
  setCheck: selectorOf(AGREE_SIGNATURES.setCheck),
} as const;

// ── shapes ───────────────────────────────────────────────────────────────────

const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** One agreement off the mandate's record, with the zero-values cleaned up. */
export interface AgreementTerms {
  /** The agreement's on-chain id: `keccak256(abi.encode(project.id, slot))`, one
   * immutable record per id (no replacement semantics — a different id is a
   * different deliverable, never a newer version of this one). */
  id: string;
  projectId: string;
  beneficiary: string;
  /** The exact reserved quantity in uint128 token units (a Share fraction's
   * worth included). It is never a cash value and never an ownership percent. */
  shares: bigint;
  criteriaHash: string;
  policyRef: string;
  /** When the beneficiary accepted (unix seconds); null while only offered. */
  acceptedAt: number | null;
  reviewPeriod: number;
  workDeadline: number;
  revisionDeadline: number;
  /** The attempt under review, or null before one is bound. */
  claimId: string | null;
  terminal: AgreementTerminal;
  attempts: number;
  /** `keccak256(abi.encode(parties, percentages))` of the declared split; zero: beneficiary alone. */
  splitHash: string;
}

/** The declared coauthor split, as the mandate's split getter answers it. */
export interface AgreedSplit {
  parties: string[];
  /** Basis points per party; the parts sum to exactly 10000. */
  percentages: number[];
}

// ── ids ──────────────────────────────────────────────────────────────────────

const assertWord = (value: string, what: string): void => {
  if (typeof value !== "string" || !WORD_RE.test(value)) {
    throw new Error(`${what} must be 0x + 64 hex characters: ${String(value)}`);
  }
};

const assertAddress = (value: string, what: string): void => {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(`${what} must be an address: ${String(value)}`);
  }
};

const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/**
 * The agreement id: `keccak256(abi.encode(projectId, slot))` — the two words
 * hashed in place, exactly what the mandate hashes when an offer lands. One
 * slot is one deliverable, so one offer cannot reach two beneficiaries.
 */
export function agreementIdOf(projectId: string, slot: string): string {
  assertWord(projectId, "project id");
  assertWord(slot, "deliverable slot");
  const digest = keccak_256(
    Uint8Array.from(
      `${projectId.replace(/^0x/, "")}${slot.replace(/^0x/, "")}`
        .match(/../g)
        ?.map((b) => Number.parseInt(b, 16)) ?? [],
    ),
  );
  return `0x${bytesToHex(digest)}`;
}

/**
 * The canonical deliverable id an offer commits: the hash of the exact
 * deliverable text. It is deliberately **not** a hash of a normalized title
 * (case, whitespace and wording are not identity) and carries no agent or
 * author identity — the work area's manager commits the text, and the slot is
 * the same bytes on every screen because it is the same hash.
 */
export function deliverableSlotKey(label: string): string {
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error("a deliverable needs text to commit to");
  }
  const digest = keccak_256(utf8ToBytes(label.trim()));
  return `0x${bytesToHex(digest)}`;
}

/**
 * An attempt's claim id: `keccak256(abi.encode(agreementId, attempt, nonce))`.
 * Every submission names its own id — never a reuse of the semantic
 * deliverable, never a silent dedup — so superseded attempts keep their place
 * in the claim escrow's history. The caller persists its own nonce.
 */
export function attemptClaimId(input: {
  agreementId: string;
  attempt: number | bigint;
  nonce: number | bigint;
}): string {
  assertWord(input.agreementId, "agreement id");
  const attempt = BigInt(input.attempt);
  const nonce = BigInt(input.nonce);
  if (attempt < 0n || attempt >= 1n << 64n)
    throw new Error("attempt out of range");
  if (nonce < 0n || nonce >= 1n << 64n) throw new Error("nonce out of range");
  const digest = keccak_256(
    Uint8Array.from(
      `${input.agreementId.replace(/^0x/, "")}${word(attempt)}${word(nonce)}`
        .match(/../g)
        ?.map((b) => Number.parseInt(b, 16)) ?? [],
    ),
  );
  return `0x${bytesToHex(digest)}`;
}

// ── splits ───────────────────────────────────────────────────────────────────

const addressWord = (a: string): string =>
  word(BigInt(`0x${a.toLowerCase().replace(/^0x/, "")}`));

/**
 * `keccak256(abi.encode(parties, percentages))` — the hash the proposal
 * commits and the acceptance must reproduce byte for byte: new reward
 * recipients can never appear later than both signatures.
 */
export function splitHashOf(
  parties: readonly string[],
  percentages: readonly number[],
): string {
  const len = word(BigInt(parties.length));
  const partyWords = parties.map(addressWord);
  const percentWords = percentages.map((p) => word(BigInt(p)));
  // ABI of two dynamic arrays: two offset words first, then an
  // (length + elements) tail each. The second offset sits after the first
  // array's whole tail (one length word plus `n` element words).
  const offset1 = 0x40n + BigInt(1 + parties.length) * 32n;
  const block =
    word(0x40n) +
    word(offset1) +
    (parties.length > 0 ? len + partyWords.join("") : "0".repeat(64)) +
    (percentages.length > 0 ? len + percentWords.join("") : "0".repeat(64));
  const digest = keccak_256(
    Uint8Array.from(
      block.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [],
    ),
  );
  return `0x${bytesToHex(digest)}`;
}

/**
 * The agreement's own declared split, validated against the contract's rules:
 * at most four real, distinct, non-manager parties; the first (owning) party
 * is the beneficiary; each percentage a non-zero basis points; the parts sum
 * to **exactly** 10000; and — where quantities are known — every declared part
 * and the residual that lands back on the first party carry at least one
 * whole token unit, so the exact total survives indivisibility. Throws with the
 * reason; returns the same shape when the beneficiary takes it all (zero
 * parts).
 */
export function confirmSplit(
  parties: readonly string[],
  percentages: readonly number[],
  context: { beneficiary: string; manager?: string | null; shares?: bigint },
): AgreedSplit {
  if (parties.length !== percentages.length) {
    throw new Error(
      `a split needs one percentage per party (${parties.length}/${percentages.length})`,
    );
  }
  if (parties.length > AGREEMENTS_MAX_SPLIT_PARTIES) {
    throw new Error(
      `a split declares at most ${AGREEMENTS_MAX_SPLIT_PARTIES} parties`,
    );
  }
  if (parties.length === 0) {
    // The whole quantity to the beneficiary: only valid where the proposal
    // declared no split — the chain answers that itself at acceptance.
    return { parties: [], percentages: [] };
  }
  const addressSet = new Set<string>();
  let total = 0;
  for (let i = 0; i < parties.length; ++i) {
    assertAddress(parties[i], "split party");
    const lower = parties[i].toLowerCase();
    if (addressSet.has(lower))
      throw new Error(`split names a party twice: ${parties[i]}`);
    if (context.manager && lower === context.manager.toLowerCase()) {
      throw new Error("split must not name the work area's own manager");
    }
    if (
      context.shares !== undefined &&
      BigInt(context.shares) * BigInt(percentages[i]) < AGREEMENTS_SPLIT_ALL
    ) {
      throw new Error(
        `party ${i + 1}'s share of the quantity is below one whole unit`,
      );
    }
    if (i === 0 && lower !== context.beneficiary.toLowerCase()) {
      throw new Error(
        "the first declared party owns the work: it must be the beneficiary",
      );
    }
    if (percentages[i] <= 0 || percentages[i] > AGREEMENTS_SPLIT_ALL) {
      throw new Error(
        `percentage out of range: ${percentages[i]} (basis points, 1..10000)`,
      );
    }
    addressSet.add(lower);
    total += percentages[i];
  }
  if (total !== AGREEMENTS_SPLIT_ALL) {
    throw new Error(
      `split percentages must sum to exactly ${AGREEMENTS_SPLIT_ALL}, got ${total}`,
    );
  }
  return { parties: [...parties], percentages: [...percentages] };
}

/**
 * What the mandate pays on settlement: each declared party takes its stated
 * share floored to a whole number of token units, the underpayment dust
 * and residual flowing back to the **first party** (the beneficiary), so the
 * exact reserved quantity is paid in total — nothing dropped, nothing invented.
 */
export function splitQuantities(
  shares: bigint,
  percentages: readonly number[],
): bigint[] {
  if (shares <= 0n) throw new Error("a quantity must be a positive bigint");
  if (percentages.length === 0) return []; // the whole quantity is the beneficiary's; nothing to divide
  const out: bigint[] = [];
  let paid = 0n;
  for (const p of percentages) {
    const part = (shares * BigInt(p)) / BigInt(AGREEMENTS_SPLIT_ALL);
    out.push(part);
    paid += part;
  }
  out[0] += shares - paid;
  return out;
}

// ── decode ───────────────────────────────────────────────────────────────────

const WORD_HEX = 64; // hex chars of one 32-byte word
const safeSeconds = (raw: bigint): number | null => {
  // Timestamps past what a JavaScript Number tracks exactly are malformed for
  // this adapter — never truncated into a wrong wall-clock.
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(raw);
};

/**
 * Decode one `agreements(bytes32)` answer into the record's own words.
 *
 * Strict: the data must be exactly 13 words (the tuple's static layout), the
 * terminal kind inside the contract's 0..3 vocabulary, every timestamp a word
 * a JavaScript number tracks exactly (timestamps past 2^53 are malformed here,
 * never truncated silently), and `attempts` a uint32. A zeroed beneficiary
 * means the id holds no agreement — returned as an **absent** row, never as a
 * legacy version and never as an empty agreement: recovery stays the
 * caller's. Anything else malformed throws, so a failed or strange read is
 * never quietly reshaped into something it is not.
 */
export function decodeAgreementRow(
  id: string,
  hex: string,
): { kind: "absent" } | { kind: "present"; terms: AgreementTerms } {
  assertWord(id, "agreement id");
  if (typeof hex !== "string")
    throw new Error(`a read must return hex: ${String(hex)}`);
  const body = hex.replace(/^0x/, "");
  if (body.length !== WORD_HEX * AGREEMENT_TUPLE.length) {
    // The read side never reshapes a wrong-shape answer into an absence.
    throw new Error(
      `the agreement tuple is ${AGREEMENT_TUPLE.length} words; this answer carries ${body.length / 2 / 32}`,
    );
  }
  const words: bigint[] = [];
  for (let i = 0; i < body.length; i += WORD_HEX) {
    words.push(BigInt(`0x${body.slice(i, i + WORD_HEX)}`));
  }
  const addressOf = (w: bigint): string =>
    `0x${w.toString(16).padStart(40, "0")}`;
  const bytes32Of = (w: bigint): string =>
    `0x${w.toString(16).padStart(64, "0")}`;
  if (words[1] === 0n) return { kind: "absent" }; // beneficiary zero: the id is free
  const terminalWord = Number(words[10]);
  const accepted = safeSeconds(words[5]);
  if (
    terminalWord < 0 ||
    terminalWord >= AGREEMENT_TERMINALS.length ||
    accepted === null
  ) {
    // A record outside what this deployment can read is an unsupported
    // capability, not an empty lane and not a legacy one.
    throw new Error(
      "the record's terminal kind or timestamps are outside this version's vocabulary",
    );
  }
  const attempts = words[11];
  if (attempts > BigInt(0xffffffff)) throw new Error("attempts past uint32");
  const reviewPeriod = safeSeconds(words[6]);
  const workDeadline = safeSeconds(words[7]);
  const revisionDeadline = safeSeconds(words[8]);
  if (
    reviewPeriod === null ||
    workDeadline === null ||
    revisionDeadline === null
  ) {
    throw new Error(
      "the record's timestamps are outside what this reader tracks exactly",
    );
  }
  return {
    kind: "present",
    terms: {
      id,
      projectId: bytes32Of(words[0]),
      beneficiary: addressOf(words[1]),
      shares: words[2],
      criteriaHash: bytes32Of(words[3]),
      policyRef: bytes32Of(words[4]),
      acceptedAt: accepted === 0 ? null : accepted,
      reviewPeriod,
      workDeadline,
      revisionDeadline,
      claimId: words[9] === 0n ? null : bytes32Of(words[9]),
      terminal: AGREEMENT_TERMINALS[terminalWord],
      attempts: Number(attempts),
      splitHash: bytes32Of(words[12]),
    },
  };
}

/**
 * The mandated split getter's answer: `(address[4] parties, uint16[4]
 * percentages, uint8 count)`. Strict by the same rules — exactly 9 words,
 * parties real addresses, `count` inside the 0..4 vocabulary (values past the
 * capacity read "outside", not as a smaller panel).
 */
export function decodeSplitsRow(id: string, hex: string): AgreedSplit {
  assertWord(id, "agreement id");
  if (typeof hex !== "string")
    throw new Error(`a read must return hex: ${String(hex)}`);
  const body = hex.replace(/^0x/, "");
  if (body.length !== WORD_HEX * (4 + 4 + 1)) {
    throw new Error(
      `the split answers in ${4 + 4 + 1} words; this carries ${body.length / 2 / 32}`,
    );
  }
  const words: bigint[] = [];
  for (let i = 0; i < body.length; i += WORD_HEX) {
    words.push(BigInt(`0x${body.slice(i, i + WORD_HEX)}`));
  }
  const count = Number(words[8]);
  if (count > AGREEMENTS_MAX_SPLIT_PARTIES)
    throw new Error(`split count out of range: ${count}`);
  const parties: string[] = [];
  const percentages: number[] = [];
  for (let i = 0; i < count; ++i) {
    parties.push(`0x${words[i].toString(16).padStart(40, "0")}`);
    const pct = words[4 + i];
    if (pct === 0n || pct > BigInt(AGREEMENTS_SPLIT_ALL)) {
      throw new Error(`split percentage out of range: ${pct}`);
    }
    percentages.push(Number(pct));
  }
  if (
    count > 0 &&
    percentages.reduce((a, b) => a + b, 0) !== AGREEMENTS_SPLIT_ALL
  ) {
    throw new Error(
      `the record's split does not sum to ${AGREEMENTS_SPLIT_ALL}`,
    );
  }
  return { parties, percentages };
}

/**
 * Prove the manager's committed coauthor split: recompute the hash the
 * proposal fixed (`splitHashOf`, the repo's own encoding + keccak) and compare
 * it byte for byte with the hash the record (or event) carries. A split whose
 * confirmation mismatched at acceptance never got reserved on chain — this is
 * the display-side check, and a mismatch says so exactly.
 */
export function matchesSplitCommitment(
  split: { parties: readonly string[]; percentages: readonly number[] },
  expectedHash: string,
): boolean {
  assertWord(expectedHash, "split hash");
  return (
    splitHashOf(split.parties, split.percentages) === expectedHash.toLowerCase()
  );
}

// ── encoders (ordered unsigned calls — never sent here) ─────────────────────

const assertQuantity = (shares: bigint): void => {
  if (typeof shares !== "bigint" || shares <= 0n || shares >= 1n << 128n) {
    throw new Error(
      "shares must be a positive uint128 bigint (a quantity, never a price)",
    );
  }
};

const assertUint64 = (value: bigint, what: string): void => {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 64n) {
    throw new Error(`${what} must be a uint64 bigint`);
  }
};

/**
 * `proposeAgreement(projectId, beneficiary, shares, workDeadline, slot,
 * policyRef, splitHash)` at the mandate. Rules mirrored from the source so a
 * typo never reaches the chain first: project id and slot must be words
 * (slot non-zero), parties must differ, quantity a positive uint128, and a
 * declared split commitment present only where a split is declared.
 */
export function encodeProposeAgreement(input: {
  projectId: string;
  beneficiary: string;
  /** Exact reserved quantity in uint128 token units — never a cash value or percent. */
  shares: bigint;
  /** The first attempt's due moment (unix seconds, uint64 bigint). */
  workDeadline: bigint;
  slot: string;
  policyRef: string;
  splitHash: string;
}): string {
  assertWord(input.projectId, "project id");
  assertWord(input.slot, "deliverable slot");
  if (input.slot === `0x${"0".repeat(64)}`)
    throw new Error("a deliverable slot is a word, not zero");
  assertAddress(input.beneficiary, "beneficiary");
  assertQuantity(input.shares);
  assertUint64(input.workDeadline, "work deadline");
  return encodeFunctionData(
    AGREE_SIGNATURES.propose,
    [
      "bytes32",
      "address",
      "uint128",
      "uint64",
      "bytes32",
      "bytes32",
      "bytes32",
    ],
    [
      input.projectId,
      input.beneficiary,
      input.shares,
      input.workDeadline,
      input.slot,
      input.policyRef,
      input.splitHash,
    ],
  );
}

/**
 * `acceptAgreement(agreementId, parties, percentages)` — the beneficiary's own
 * financial moment. An empty declaration is only valid when the proposal
 * committed none (splitHash zero); parts validated like the mandate's own
 * `_declareSplit`, with the quantity passed so indivisibility is caught here
 * before the chain gives its own budget answer. When the caller knows the
 * agreement's beneficiary (from the record) and the project's manager, the
 * shape gets their checks too — the chain still answers for ownership.
 */
export function encodeAcceptAgreement(input: {
  agreementId: string;
  shares: bigint;
  parties: readonly string[];
  percentages: readonly number[];
  governance?: { beneficiary?: string; manager?: string | null };
}): string {
  assertWord(input.agreementId, "agreement id");
  assertQuantity(input.shares);
  const split = confirmSplit(input.parties, input.percentages, {
    beneficiary: input.governance?.beneficiary ?? input.parties[0] ?? "",
    manager: input.governance?.manager ?? null,
    shares: input.shares,
  });
  return encodeFunctionData(
    AGREE_SIGNATURES.accept,
    ["bytes32", { array: "address" }, { array: "uint16" }],
    [input.agreementId, split.parties, split.percentages.map((p) => BigInt(p))],
  );
}

/**
 * `bindSubmission(agreementId, claimId)` at the mandate — the offer's attempt
 * binding (first attempt under the work deadline; replacements inside the
 * corrections route under the revision deadline). Returns only the call bytes;
 * whoever sends them must be able to actually do that on chain.
 */
export function encodeBindSubmission(
  agreementId: string,
  claimId: string,
): string {
  assertWord(agreementId, "agreement id");
  assertWord(claimId, "claim id");
  return encodeFunctionData(
    AGREE_SIGNATURES.bindSubmission,
    ["bytes32", "bytes32"],
    [agreementId, claimId],
  );
}

/** `releaseAgreement(agreementId)` — cancel by a party, expire by anyone. */
export function encodeReleaseAgreement(agreementId: string): string {
  assertWord(agreementId, "agreement id");
  return encodeFunctionData(
    AGREE_SIGNATURES.release,
    ["bytes32"],
    [agreementId],
  );
}

/**
 * `settleAgreement(mandate, agreementId)` **at the DAO** — the permissionless
 * settlement: the recipients and the exact reserved quantity are the record's,
 * never caller-chosen, and the DAO reverts anything that is not an approved,
 * window-elapsed claim matching the agreed criteria the record fixed.
 */
export function encodeSettleAgreement(
  dao: string,
  mandate: string,
  agreementId: string,
): string {
  assertAddress(dao, "dao");
  assertAddress(mandate, "mandate");
  assertWord(agreementId, "agreement id");
  return encodeFunctionData(
    AGREE_SIGNATURES.settle,
    ["address", "bytes32"],
    [mandate, agreementId],
  );
}

/**
 * `requestCorrections(claimId, reasonHash)` on the mandate's reviewer set —
 * a NON-final request for changes the mandate's corrections route reads; a
 * corrections request is never an objection vote against the work.
 */
export function encodeRequestCorrections(
  claimId: string,
  reasonHash: string,
): string {
  assertWord(claimId, "claim id");
  assertWord(reasonHash, "reason hash");
  return encodeFunctionData(
    AGREE_SIGNATURES.requestCorrections,
    ["bytes32", "bytes32"],
    [claimId, reasonHash],
  );
}

// ── reads (encoders only; reading itself is `agreementsRead.ts`) ────────────

export const encodeReadAgreementsVersion = (): string =>
  selectorOf(AGREE_SIGNATURES.version);
export const encodeReadAgreement = (agreementId: string): string => {
  assertWord(agreementId, "agreement id");
  return encodeFunctionData(
    AGREE_SIGNATURES.agreements,
    ["bytes32"],
    [agreementId],
  );
};
export const encodeReadSplits = (agreementId: string): string => {
  assertWord(agreementId, "agreement id");
  return encodeFunctionData(
    AGREE_SIGNATURES.splits,
    ["bytes32"],
    [agreementId],
  );
};
export const encodeReadSharesReserved = (projectId: string): string => {
  assertWord(projectId, "project id");
  return encodeFunctionData(
    AGREE_SIGNATURES.sharesReserved,
    ["bytes32"],
    [projectId],
  );
};
export const encodeReadAgreementOfClaim = (claimId: string): string => {
  assertWord(claimId, "claim id");
  return encodeFunctionData(
    AGREE_SIGNATURES.agreementOfClaim,
    ["bytes32"],
    [claimId],
  );
};
export const encodeReadCorrectionsCount = (claimId: string): string => {
  assertWord(claimId, "claim id");
  return encodeFunctionData(
    AGREE_SIGNATURES.correctionsCount,
    ["bytes32"],
    [claimId],
  );
};

// ── the offer's first attempt, as one batch ─────────────────────────────────

/**
 * The offer's first attempt one offer at a time, in the exact order the
 * mandate requires it: submit the claim (no currency ask — the agreed reward
 * is Shares), state the agreed acceptance check, then **bind submission**.
 * Steps are ordered unsigned calls — nothing here sends, funds, signs or
 * broadcasts; `to` is the mandate/escrow each step needs.
 *
 * The claim id should come from `attemptClaimId` against a caller-persisted
 * nonce (never a re-use of the semantic deliverable: semantic dedup is off the
 * table). The artifact draft is the caller's durable local artifact to keep,
 * exactly as the evidence text was typed, and a matching hash does not prove
 * the claims it contains — it only proves that what was signed is what was
 * committed here.
 */
export function buildAgreedSubmissionBatch(input: {
  mandate: string;
  /** The work escrow of the offer's own mandate (the mandate's `claims()`). */
  claims: string;
  agreementId: string;
  claimId: string;
  /** The beneficiary's counter-stake, if the offer asked one; zero is usual. */
  stake?: bigint;
  evidenceHash: string;
  /** The agreed criteria hash — the check the claim must state to bind. */
  criteriaHash: string;
}): { to: string; data: string }[] {
  const { claims: claimsAddress, mandate } = input;
  assertAddress(claimsAddress, "claims escrow");
  assertAddress(mandate, "mandate");
  assertWord(input.claimId, "claim id");
  assertWord(input.evidenceHash, "evidence hash");
  assertWord(input.criteriaHash, "criteria hash");
  const stake = input.stake ?? 0n;
  if (typeof stake !== "bigint" || stake < 0n)
    throw new Error("stake must be a non-negative bigint");
  return [
    {
      to: claimsAddress,
      data: encodeFunctionData(
        AGREE_SIGNATURES.submitClaim,
        ["bytes32", "uint256", "uint256", "bytes32"],
        [input.claimId, 0n, stake, input.evidenceHash],
      ),
    },
    {
      to: claimsAddress,
      data: encodeFunctionData(
        AGREE_SIGNATURES.setCheck,
        ["bytes32", "bytes32"],
        [input.claimId, input.criteriaHash],
      ),
    },
    {
      to: mandate,
      data: encodeBindSubmission(input.agreementId, input.claimId),
    },
  ];
}

// ── what happens next ───────────────────────────────────────────────────────

/** Who a next step belongs to. A quiet agreement names no one. */
type NextActionParty =
  | "manager"
  | "beneficiary"
  | "reviewer"
  | "anyone"
  | "none";

/** Which role this viewer plays in the agreement (drives which edges they see). */
export interface AgreementViewer {
  manager?: boolean;
  beneficiary?: boolean;
  reviewer?: boolean;
}

/** One named next step: who can take it, by when it must be, why it stands. */
export interface AgreementNextAction {
  /** The offer's own lifecycle word (summarized; see `agreementStateOf`). */
  state: string;
  /** Whose open turn it is (`none` when the record is quiet). */
  actor: NextActionParty;
  /** The one verb phrase of the step, or null when there is nothing to take. */
  action: string | null;
  /** The deadline unix seconds that nightfall this step, when it has one. */
  due: number | null;
  /** Why it stands, in one sentence (no promise, no price, no optimist). */
  note: string;
}

/**
 * The record alone's lifecycle word: absent / offered / agreed / settled /
 * cancelled / expired. Review timing lives in the claim the attempt was bound
 * with, not in the record — pass `claimStatus` for the finer edges.
 */
export function agreementStateOf(
  record: {
    beneficiary: string;
    acceptedAt: number | null;
    terminal: AgreementTerminal;
  } | null,
): "absent" | "offered" | "agreed" | "settled" | "cancelled" | "expired" {
  if (!record || record.beneficiary === `0x${"0".repeat(40)}`) return "absent";
  if (record.terminal !== "active") return record.terminal;
  return record.acceptedAt === null ? "offered" : "agreed";
}

/**
 * The next open step of an agreed contribution, from the record's real states
 * and the real timestamps — never from what a vote *might* award: the
 * discretionary lane cannot touch a promised quantity at all, so no step of
 * this is "await a vote".
 *
 * Review timing reads the claim the attempt was bound with (every panel gate
 * (`quorum`, corrections count) caller-supplied, from the **actual** counts —
 * this helper never invents a "2 of 3" panel or an automatic acceptance):
 *
 * - absent → nobody's turn;
 * - offered → the beneficiary accepts (their financial moment), or a party
 *   takes the offer off the board;
 * - agreed, no attempt bound → the beneficiary submits before the work
 *   deadline; past it, anyone lets it lapse (`releaseAgreement`);
 * - agreed, attempt `Open` → the reviewer panel's turn (or wait), corrections
 *   are still open; the manager may rebind inside corrections **before** the
 *   revision deadline; with quorum reached, anyone settles the claim —
 *   then the challenge window runs, and only an approved, window-elapsed
 *   attempt settles the agreement itself;
 * - attempt `Approved` or `Paid` → ready to settle: anyone calls the DAO's
 *   permissionless settlement; inside the challenge window the dispute paths
 *   still stand first;
 * - attempt rejected/expired/recovered → the reservation releases: anyone
 *   calls `releaseAgreement`; a frozen claim waits on the dispute path and
 *   is named as such.
 *
 * Budgets show their answer at acceptance, never before: nothing here
 * promises a reservation headroom — only the on-chain acceptance confirms it.
 */
export function nextAgreementAction(
  record: AgreementTerms | null,
  now: number | bigint,
  context: {
    claimStatus?: ClaimStatus | null;
    /** The attempt's review deadline (pinned onto the claim at bind). */
    reviewDeadline?: number | null;
    /** The approval quorum the panel was made with, as it actually stands. */
    quorum?: number | null;
    /** The claim's actual approval count (bindings included). */
    approvals?: number | null;
    /** Whether a reviewer has a formal corrections request on record. */
    correctionsRequested?: boolean;
    /** The claim's challenge window, once the attempt released. */
    challengeWindow?: number | null;
    viewer?: AgreementViewer | null;
  } = {},
): AgreementNextAction | null {
  const at = typeof now === "bigint" ? Number(now) : now;
  if (!record) return null;
  const state = agreementStateOf(record);
  if (state === "absent") {
    return {
      state,
      actor: "none",
      action: null,
      due: null,
      note: "No offer stands at this deliverable.",
    };
  }
  if (state === "cancelled") {
    return {
      state,
      actor: "none",
      action: null,
      due: null,
      note: "The offer was taken off the board before agreeing.",
    };
  }
  if (state === "settled") {
    return {
      state,
      actor: "none",
      action: null,
      due: null,
      note: "The agreement settled exactly on its terms.",
    };
  }
  if (state === "expired") {
    return {
      state,
      actor: "none",
      action: null,
      due: null,
      note: "The agreement expired without a delivery it kept.",
    };
  }
  if (state === "offered") {
    if (at >= record.workDeadline) {
      return {
        state,
        actor: "anyone",
        action: "Take the offer off the board",
        due: null,
        note: "The work deadline passed unaccepted; either party may still cancel it.",
      };
    }
    return {
      state,
      actor: "beneficiary",
      action: "Accept the offer",
      due: record.workDeadline,
      note: "Accepting is the financial moment: this quantity is reserved against the work area's own ceiling then, never before.",
    };
  }
  // agreed (active), accepted — the work lane. A step addressed to one viewer
  // keeps its party and its reason; anyone-steps stay open to everyone, and a
  // step that is not the viewer's turn is shown without an offered action.
  const forViewer = (
    party: NextActionParty,
    action: string | null,
  ): {
    actor: NextActionParty;
    action: string | null;
  } => {
    const mine =
      !context.viewer ||
      party === "anyone" ||
      (party === "manager" && context.viewer.manager) ||
      (party === "beneficiary" && context.viewer.beneficiary) ||
      (party === "reviewer" && context.viewer.reviewer) ||
      party === "none";
    const actor = party === "none" ? "none" : party;
    return { actor: mine ? actor : "none", action: mine ? action : null };
  };
  if (!record.claimId) {
    if (at >= record.workDeadline) {
      return {
        state,
        ...forViewer("anyone", "Release the reservation"),
        due: null,
        note: "The work deadline passed unsubmitted: anyone may expire it and free the reservation.",
      };
    }
    return {
      state,
      ...forViewer("beneficiary", "Submit the deliverable"),
      due: record.workDeadline,
      note: "One submission at a time, at no currency ask. The quantity this spends was reserved at acceptance, never promised afterwards.",
    };
  }
  const status = context.claimStatus ?? "unknown";
  const revisionOpen = at < record.revisionDeadline;
  switch (status) {
    case "Approved":
    case "Paid": {
      const challenge = context.challengeWindow ?? null;
      return {
        state: "ready-to-settle",
        ...forViewer("anyone", "Settle the agreement"),
        due: null,
        note: challenge
          ? "Approved on its own terms; once the challenge window has passed anyone may settle it at the record's exact quantity."
          : "Approved on its own terms; anyone may settle it at the record's exact quantity once the challenge window completes.",
      };
    }
    case "Open": {
      const reviewDeadline = context.reviewDeadline ?? null;
      if (reviewDeadline && at >= reviewDeadline) {
        return {
          state: "in-review",
          ...forViewer("anyone", "Let the attempt lapse"),
          due: null,
          note: "The review did not conclude in the agreed period: the attempt lapses on its own, and the reservation then releases by explicit action.",
        };
      }
      if (context.correctionsRequested && revisionOpen) {
        return {
          state: "in-review",
          ...forViewer("manager", "Bind a corrected attempt"),
          due: record.revisionDeadline,
          note: "A reviewer formally asked for corrections: the manager may replace the open attempt inside the revision window, retiring the old attempt (no verdict, the stake back unslashed).",
        };
      }
      const q = context.quorum ?? 0;
      if (q > 0 && (context.approvals ?? 0) >= q) {
        return {
          state: "in-review",
          ...forViewer("anyone", "Settle the claim"),
          due: reviewDeadline,
          note: "The panel reached its actual quorum: anyone may settle the claim, which is what starts the attempt's challenge window.",
        };
      }
      return {
        state: "in-review",
        ...forViewer("reviewer", "Judge the attempt"),
        due: reviewDeadline,
        note: "The panel judges one attempt at a time against the agreed criteria; no decision lands by itself and nothing accepts automatically.",
      };
    }
    case "Rejected":
    case "Expired":
    case "Recovered":
      return {
        state: "in-review",
        ...forViewer("anyone", "Release the reservation"),
        due: null,
        note: "The attempt resolved unapproved: the reservation releases explicitly, no mint appears, and a retry is a new agreement's own terms.",
      };
    case "Frozen":
      return {
        state: "in-review",
        ...forViewer("manager", null),
        due: null,
        note: "The claim is frozen in dispute: the reservation releases on nothing but the attempt's own resolution.",
      };
    default:
      return {
        state: "in-review",
        actor: "none",
        action: null,
        due: null,
        note: "The attempt's state could not be read yet, so nothing is named as a next step here.",
      };
  }
}
