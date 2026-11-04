import assert from "node:assert/strict";
import test from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  AGREE_SELECTORS,
  AGREEMENT_TERMINALS,
  AGREEMENTS_MAX_SPLIT_PARTIES,
  agreementIdOf,
  agreementStateOf,
  attemptClaimId,
  buildAgreedSubmissionBatch,
  confirmSplit,
  decodeAgreementRow,
  decodeSplitsRow,
  deliverableSlotKey,
  encodeAcceptAgreement,
  encodeBindSubmission,
  encodeProposeAgreement,
  encodeReadAgreementsVersion,
  encodeReadAgreement,
  encodeReadSplits,
  encodeReleaseAgreement,
  encodeRequestCorrections,
  encodeSettleAgreement,
  matchesSplitCommitment,
  nextAgreementAction,
  splitHashOf,
  splitQuantities,
} from "./agreements.ts";

// ---------------------------------------------------------------------------
// Independent hex helpers — the "cast" side of the differential pins: every
// golden here is assembled word by word, never by the module under test.
// ---------------------------------------------------------------------------

const word = (n) => n.toString(16).padStart(64, "0");
const addressWord = (a) =>
  word(BigInt(`0x${a.toLowerCase().replace(/^0x/, "")}`));
const wordOf = (h) => h.replace(/^0x/, "").padStart(64, "0").slice(0, 64);
const keccak = (hex) =>
  "0x" +
  bytesToHex(
    keccak_256(
      Uint8Array.from(
        hex
          .replace(/^0x/, "")
          .match(/../g)
          .map((b) => Number.parseInt(b, 16)),
      ),
    ),
  );

const PROJECT = "0x" + "1".repeat(64);
const SLOT = "0x" + "ab".repeat(32);
const AGREEMENT_ID = keccak(
  PROJECT.replace(/^0x/, "") + SLOT.replace(/^0x/, ""),
);
const BENEFICIARY = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";
const COAUTHOR = "0x3333333333333333333333333333333333333333";
const DAO = "0x4444444444444444444444444444444444444444";
const MANDATE = "0x5555555555555555555555555555555555555555";
const CLAIMS = "0x6666666666666666666666666666666666666666";
const CLAIM = "0x" + "cc".repeat(32);
const CRITERIA = "0x" + "55".repeat(32);
const POLICY = "0x" + "66".repeat(32);
const EVIDENCE = "0x" + "77".repeat(32);
const SPLIT_HASH = "0x" + "88".repeat(32);

// ── selectors, ids, deliverable identity ─────────────────────────────────────

test("selectors match the pinned goldens", () => {
  assert.equal(AGREE_SELECTORS.version, "0xf964bc9e");
  assert.equal(AGREE_SELECTORS.agreements, "0x9e1f68c7");
  assert.equal(AGREE_SELECTORS.propose, "0x956ea366");
  assert.equal(AGREE_SELECTORS.accept, "0x119260be");
  assert.equal(AGREE_SELECTORS.bindSubmission, "0x3daaf099");
  assert.equal(AGREE_SELECTORS.release, "0x7bb76eb2");
  assert.equal(AGREE_SELECTORS.splits, "0xa72bc064");
  assert.equal(AGREE_SELECTORS.sharesReserved, "0xfe0c438a");
  assert.equal(AGREE_SELECTORS.agreementOfClaim, "0xa63e06bd");
  assert.equal(AGREE_SELECTORS.settle, "0x9449050e");
  assert.equal(AGREE_SELECTORS.requestCorrections, "0xe388c7bf");
});

test("an agreement id keccak-hashes the project and slot words in place", () => {
  assert.equal(agreementIdOf(PROJECT, SLOT), AGREEMENT_ID);
  assert.notEqual(agreementIdOf(PROJECT, "0x" + "cd".repeat(32)), AGREEMENT_ID);
  assert.notEqual(agreementIdOf("0x" + "2".repeat(64), SLOT), AGREEMENT_ID);
  assert.throws(() => agreementIdOf("0x1234", SLOT), /project id/);
});

test("the deliverable id is the committed text, never a normalized title or an agent identity", () => {
  assert.equal(
    deliverableSlotKey("first deploy"),
    deliverableSlotKey(" first deploy "),
  );
  assert.notEqual(
    deliverableSlotKey("first deploy"),
    deliverableSlotKey("First Deploy"),
  );
  assert.notEqual(
    deliverableSlotKey("deploy"),
    deliverableSlotKey("deploy all"),
  );
  assert.throws(() => deliverableSlotKey("   "), /deliverable/);
});

test("attempt claim ids name each attempt exactly once (semantic dedup is off)", () => {
  const first = attemptClaimId({
    agreementId: AGREEMENT_ID,
    attempt: 1,
    nonce: 7,
  });
  assert.notEqual(
    first,
    attemptClaimId({ agreementId: AGREEMENT_ID, attempt: 1, nonce: 8 }),
  );
  assert.notEqual(
    first,
    attemptClaimId({ agreementId: AGREEMENT_ID, attempt: 2, nonce: 7 }),
  );
  assert.equal(
    first,
    attemptClaimId({ agreementId: AGREEMENT_ID, attempt: 1n, nonce: 7n }),
  );
  assert.throws(
    () =>
      attemptClaimId({
        agreementId: AGREEMENT_ID,
        attempt: 1n << 64n,
        nonce: 1,
      }),
    /attempt/,
  );
});

// ── split terms ──────────────────────────────────────────────────────────────

test("the declared split hash is the ABI image the contract keccak-hashes", () => {
  const head =
    word(0x40) +
    word(0xa0n) +
    word(2n) +
    addressWord(BENEFICIARY) +
    addressWord(COAUTHOR) +
    word(2n) +
    word(3300n) +
    word(6700n);
  assert.equal(
    splitHashOf([BENEFICIARY, COAUTHOR], [3300, 6700]),
    keccak(head),
  );
  const empty = word(0x40n) + word(0x60n) + word(0n) + word(0n);
  assert.equal(splitHashOf([], []), keccak(empty));
  assert.notEqual(
    splitHashOf([BENEFICIARY, COAUTHOR], [3300, 6700]),
    splitHashOf([COAUTHOR, BENEFICIARY], [6700, 3300]),
  );
});

test("coauthor terms are committed: changing them never reproduces the hash", () => {
  const hash = splitHashOf([BENEFICIARY, COAUTHOR], [3300, 6700]);
  assert.equal(
    matchesSplitCommitment(
      { parties: [BENEFICIARY, COAUTHOR], percentages: [3300, 6700] },
      hash,
    ),
    true,
  );
  assert.equal(
    matchesSplitCommitment(
      { parties: [BENEFICIARY, COAUTHOR], percentages: [5000, 5000] },
      hash,
    ),
    false,
  );
  assert.equal(
    matchesSplitCommitment(
      { parties: [COAUTHOR, BENEFICIARY], percentages: [6700, 3300] },
      hash,
    ),
    false,
  );
});

test("declared splits follow the mandate's own rules, rejections say why", () => {
  assert.throws(
    () =>
      confirmSplit([BENEFICIARY, COAUTHOR], [3300, 6701], {
        beneficiary: BENEFICIARY,
      }),
    /exactly 10000/,
  );
  assert.throws(
    () =>
      confirmSplit([COAUTHOR, BENEFICIARY], [6700, 3300], {
        beneficiary: BENEFICIARY,
      }),
    /first declared party/,
  );
  assert.throws(
    () =>
      confirmSplit([BENEFICIARY, MANAGER], [3300, 6700], {
        beneficiary: BENEFICIARY,
        manager: MANAGER,
      }),
    /manager/,
  );
  assert.throws(
    () =>
      confirmSplit([BENEFICIARY, COAUTHOR, COAUTHOR], [3300, 3700, 3000], {
        beneficiary: BENEFICIARY,
      }),
    /twice/,
  );
  assert.throws(
    () =>
      confirmSplit([BENEFICIARY, COAUTHOR], [3300, 6700], {
        beneficiary: BENEFICIARY,
        shares: 2n,
      }),
    /whole unit/,
  );
  assert.throws(
    () =>
      confirmSplit(
        [
          BENEFICIARY,
          COAUTHOR,
          DAO,
          `0x7777777777777777777777777777777777777777`,
          `0x8888888888888888888888888888888888888888`,
        ],
        [3000, 2000, 2000, 2000, 1000],
        { beneficiary: BENEFICIARY },
      ),
    /most 4/,
  );
  assert.equal(AGREEMENTS_MAX_SPLIT_PARTIES, 4);
  // A whole-quantity declaration (no split) passes; the chain still answers ownership.
  assert.deepEqual(confirmSplit([], [], { beneficiary: BENEFICIARY }), {
    parties: [],
    percentages: [],
  });
});

test("settlement pays the exact quantity: parts floor to whole units, residual to the first party", () => {
  const q101 = splitQuantities(101n, [3300, 6700]);
  assert.deepEqual(
    [...q101],
    [34n, 67n],
    "floor of 33/100 is 33; the 1 leftover goes to the first party",
  );
  assert.equal(q101[0] + q101[1], 101n);
  const odd = splitQuantities(999n, [3300, 6700]);
  assert.equal(odd[0] + odd[1], 999n);
  // Indivisibility at the minimum: the residual keeps the first party whole.
  const small = splitQuantities(4n, [3300, 6700]);
  assert.deepEqual([...small], [2n, 2n]);
  assert.equal(small[0] + small[1], 4n);
  assert.throws(() => splitQuantities(0n, [3300, 6700]), /positive/);
  const whole = splitQuantities(50n, []);
  assert.equal(whole.length, 0);
});

// ── encoders: exact call bytes ────────────────────────────────────────────────

test("share quantities are bigints with uint128 bounds, never a price", () => {
  const base = {
    projectId: PROJECT,
    beneficiary: BENEFICIARY,
    shares: 100n,
    workDeadline: 5000n,
    slot: SLOT,
    policyRef: POLICY,
    splitHash: "0x" + "0".repeat(64),
  };
  assert.throws(
    () => encodeProposeAgreement({ ...base, shares: 1n << 128n }),
    /uint128/,
  );
  assert.throws(
    () => encodeProposeAgreement({ ...base, shares: 0n }),
    /positive uint128/,
  );
  assert.throws(
    () => encodeProposeAgreement({ ...base, shares: 1.5e15 }),
    /bigint/,
  );
  assert.throws(
    () => encodeProposeAgreement({ ...base, workDeadline: 1n << 64n }),
    /uint64/,
  );
  assert.throws(
    () =>
      encodeProposeAgreement({
        ...base,
        slot: "0x" + "0".repeat(64),
      }),
    /slot/,
  );
});

test("proposeAgreement encodes the mandate's seven-arg call", () => {
  const data = encodeProposeAgreement({
    projectId: PROJECT,
    beneficiary: BENEFICIARY,
    shares: 100n,
    workDeadline: 5000n,
    slot: SLOT,
    policyRef: POLICY,
    splitHash: "0x" + "0".repeat(64),
  });
  const expected =
    AGREE_SELECTORS.propose +
    wordOf(PROJECT) +
    addressWord(BENEFICIARY) +
    word(100n) +
    word(5000n) +
    wordOf(SLOT) +
    wordOf(POLICY) +
    word(0n);
  assert.equal(data.toLowerCase(), expected);
});

test("acceptAgreement encodes the two dynamic arrays the mandate declares", () => {
  const data = encodeAcceptAgreement({
    agreementId: AGREEMENT_ID,
    shares: 101n,
    parties: [BENEFICIARY, COAUTHOR],
    percentages: [3300, 6700],
  });
  const expected =
    AGREE_SELECTORS.accept +
    wordOf(AGREEMENT_ID) +
    word(0x60n) + // the head is id + two offset words; offsets are block-relative
    word(0xc0n) + // after the first tail (length word + 2 words)
    word(2n) +
    addressWord(BENEFICIARY) +
    addressWord(COAUTHOR) +
    word(2n) +
    word(3300n) +
    word(6700n);
  assert.equal(data.toLowerCase(), expected);
  const whole = encodeAcceptAgreement({
    agreementId: AGREEMENT_ID,
    shares: 101n,
    parties: [],
    percentages: [],
  });
  const wholeExpected =
    AGREE_SELECTORS.accept +
    wordOf(AGREEMENT_ID) +
    word(0x60n) +
    word(0x80n) +
    word(0n) +
    word(0n);
  assert.equal(whole.toLowerCase(), wholeExpected);
});

test("bind, release, settle, reviewer corrections and the id reads encode word for word", () => {
  assert.equal(
    encodeBindSubmission(AGREEMENT_ID, CLAIM).toLowerCase(),
    AGREE_SELECTORS.bindSubmission + wordOf(AGREEMENT_ID) + wordOf(CLAIM),
  );
  assert.equal(
    encodeReleaseAgreement(AGREEMENT_ID).toLowerCase(),
    AGREE_SELECTORS.release + wordOf(AGREEMENT_ID),
  );
  assert.equal(
    encodeSettleAgreement(DAO, MANDATE, AGREEMENT_ID).toLowerCase(),
    AGREE_SELECTORS.settle + addressWord(MANDATE) + wordOf(AGREEMENT_ID),
  );
  const reason = "0x" + "aa".repeat(32);
  assert.equal(
    encodeRequestCorrections(CLAIM, reason).toLowerCase(),
    AGREE_SELECTORS.requestCorrections + wordOf(CLAIM) + wordOf(reason),
  );
  assert.equal(encodeReadAgreementsVersion(), AGREE_SELECTORS.version);
  assert.equal(
    encodeReadAgreement(AGREEMENT_ID).toLowerCase(),
    AGREE_SELECTORS.agreements + wordOf(AGREEMENT_ID),
  );
  assert.equal(
    encodeReadSplits(AGREEMENT_ID).toLowerCase(),
    AGREE_SELECTORS.splits + wordOf(AGREEMENT_ID),
  );
});

test("the offer's first attempt is one ordered batch: submit, set the agreed check, then bind", () => {
  const batch = buildAgreedSubmissionBatch({
    mandate: MANDATE,
    claims: CLAIMS,
    agreementId: AGREEMENT_ID,
    claimId: CLAIM,
    stake: 1n,
    evidenceHash: EVIDENCE,
    criteriaHash: CRITERIA,
  });
  assert.equal(batch.length, 3);
  assert.deepEqual(
    batch.map((s) => s.to),
    [CLAIMS, CLAIMS, MANDATE],
  );
  assert.equal(
    batch[0].data.toLowerCase(),
    AGREE_SELECTORS.submitClaim +
      wordOf(CLAIM) +
      word(0n) +
      word(1n) +
      wordOf(EVIDENCE),
  );
  assert.equal(
    batch[1].data.toLowerCase(),
    AGREE_SELECTORS.setCheck + wordOf(CLAIM) + wordOf(CRITERIA),
  );
  assert.equal(batch[2].data, encodeBindSubmission(AGREEMENT_ID, CLAIM));
});

// ── decoding the mandate's record ────────────────────────────────────────────

const TERMINAL_ACTIVE = 0;
const TERMINAL_SETTLED = 1;
const TERMINAL_CANCELLED = 2;
const TERMINAL_EXPIRED = 3;

const encodeRecord = (o) => {
  void TERMINAL_ACTIVE;
  void TERMINAL_SETTLED;
  void TERMINAL_CANCELLED;
  void TERMINAL_EXPIRED;
  return (
    wordOf(o.projectId ?? "0x" + "0".repeat(32)) +
    (o.beneficiary ? addressWord(o.beneficiary) : word(0n)) +
    word(o.shares ?? 0n) +
    wordOf(o.criteriaHash ?? "0x" + "0".repeat(32)) +
    wordOf(o.policyRef ?? "0x" + "0".repeat(32)) +
    word(BigInt(o.acceptedAt ?? 0)) +
    word(BigInt(o.reviewPeriod ?? 0)) +
    word(BigInt(o.workDeadline ?? 0)) +
    word(BigInt(o.revisionDeadline ?? 0)) +
    wordOf(o.claimId ?? "0x" + "0".repeat(32)) +
    word(BigInt(o.terminalKind ?? 0)) +
    word(BigInt(o.attempts ?? 0)) +
    wordOf(o.splitHash ?? "0x" + "0".repeat(32))
  );
};

const fullTerms = {
  projectId: PROJECT,
  beneficiary: BENEFICIARY,
  shares: 101n,
  criteriaHash: CRITERIA,
  policyRef: POLICY,
  acceptedAt: 500,
  reviewPeriod: 7 * 86_400,
  workDeadline: 1600,
  revisionDeadline: 3_000_000,
  claimId: CLAIM,
  // the lifecycle word `nextAgreementAction` reads, beside the record's own kind
  terminal: "active",
  terminalKind: TERMINAL_ACTIVE,
  attempts: 1,
  splitHash: SPLIT_HASH,
};

test("a record decodes into its own words; a zeroed id is absent, not empty and not legacy", () => {
  const decoded = decodeAgreementRow(
    AGREEMENT_ID,
    "0x" + encodeRecord(fullTerms),
  );
  assert.equal(decoded.kind, "present");
  const t = decoded.terms;
  assert.equal(t.id, AGREEMENT_ID);
  assert.equal(t.projectId, PROJECT);
  assert.equal(t.beneficiary, BENEFICIARY);
  assert.equal(typeof t.shares, "bigint");
  assert.equal(t.shares, 101n);
  assert.equal(t.acceptedAt, 500);
  assert.equal(t.workDeadline, 1600);
  assert.equal(t.claimId, CLAIM);
  assert.equal(t.terminal, "active");
  assert.equal(t.attempts, 1);
  assert.equal(t.splitHash, SPLIT_HASH);
  const unbound = decodeAgreementRow(
    AGREEMENT_ID,
    "0x" + encodeRecord({ ...fullTerms, claimId: undefined, acceptedAt: 0 }),
  );
  assert.equal(unbound.terms.claimId, null);
  assert.equal(unbound.terms.acceptedAt, null);
  assert.equal(agreementStateOf(unbound.terms), "offered");
  const absent = decodeAgreementRow(AGREEMENT_ID, "0x" + encodeRecord({}));
  assert.equal(absent.kind, "absent");
});

test("a malformed answer is refused, never reshaped into an absence or a legacy version", () => {
  assert.throws(
    () => decodeAgreementRow(AGREEMENT_ID, "0x1234"),
    /13 words|tuple/,
  );
  const good = "0x" + encodeRecord(fullTerms);
  assert.throws(
    () => decodeAgreementRow(AGREEMENT_ID, good.slice(0, -2)),
    /13 words|tuple/,
  );
  assert.throws(
    () =>
      decodeAgreementRow(
        AGREEMENT_ID,
        "0x" + encodeRecord({ ...fullTerms, terminalKind: 4 }),
      ),
    /outside this version/,
  );
  assert.throws(
    () =>
      decodeAgreementRow(
        AGREEMENT_ID,
        "0x" + encodeRecord({ ...fullTerms, acceptedAt: 1n << 60n }),
      ),
    /timestamp|this version/,
  );
  assert.throws(
    () =>
      decodeAgreementRow(
        AGREEMENT_ID,
        "0x" + encodeRecord({ ...fullTerms, attempts: 1n << 32n }),
      ),
    /uint32/,
  );
});

test("the split getter is the split's source, validated strictly", () => {
  const splitHex =
    "0x" +
    addressWord(BENEFICIARY) +
    addressWord(COAUTHOR) +
    word(0n) +
    word(0n) +
    word(3300n) +
    word(6700n) +
    word(0n) +
    word(0n) +
    word(2n);
  assert.deepEqual(decodeSplitsRow(AGREEMENT_ID, splitHex), {
    parties: [BENEFICIARY, COAUTHOR],
    percentages: [3300, 6700],
  });
  const noneHex = "0x" + word(0n).repeat(9);
  assert.deepEqual(decodeSplitsRow(AGREEMENT_ID, noneHex), {
    parties: [],
    percentages: [],
  });
  assert.throws(
    () => decodeSplitsRow(AGREEMENT_ID, "0x" + word(0n).repeat(8) + word(5n)),
    /out of range/,
  );
  const notExact =
    "0x" +
    word(0n).repeat(4) +
    word(3300n) +
    word(3333n) +
    word(0n).repeat(2) +
    word(2n);
  assert.throws(() => decodeSplitsRow(AGREEMENT_ID, notExact), /10000/);
  assert.throws(() => decodeSplitsRow(AGREEMENT_ID, "0xzz"), /hex|read|split/i);
});

// ── lifecycle and next steps ─────────────────────────────────────────────────

test("the lifecycle words track the record exactly", () => {
  assert.equal(agreementStateOf(null), "absent");
  assert.equal(
    agreementStateOf({
      beneficiary: BENEFICIARY,
      acceptedAt: null,
      terminal: "active",
    }),
    "offered",
  );
  assert.equal(
    agreementStateOf({
      beneficiary: BENEFICIARY,
      acceptedAt: 5,
      terminal: "active",
    }),
    "agreed",
  );
  assert.equal(
    agreementStateOf({
      beneficiary: BENEFICIARY,
      acceptedAt: 5,
      terminal: AGREEMENT_TERMINALS[1],
    }),
    "settled",
  );
  assert.equal(
    agreementStateOf({
      beneficiary: BENEFICIARY,
      acceptedAt: 5,
      terminal: AGREEMENT_TERMINALS[TERMINAL_EXPIRED],
    }),
    "expired",
  );
});

test("offered work: the beneficiary accepts; past the deadline anyone clears it", () => {
  const offered = { ...fullTerms, acceptedAt: null, claimId: null };
  const now = nextAgreementAction(offered, 1000);
  assert.equal(now.actor, "beneficiary");
  assert.match(now.action, /Accept/);
  assert.equal(now.due, 1600);
  assert.match(now.note, /financial moment|reserved/);
  assert.doesNotMatch(now.note, /safe to invest|guaranteed/);
  const late = nextAgreementAction(offered, 1600);
  assert.equal(late.actor, "anyone");
  assert.match(late.action, /off the board/);
});

test("agreed work: the beneficiary submits; past the deadline anyone frees the reservation", () => {
  const terms = { ...fullTerms, claimId: null, acceptedAt: 500 };
  const open = nextAgreementAction(terms, 1000);
  assert.equal(open.actor, "beneficiary");
  assert.match(open.action, /Submit/);
  assert.equal(open.due, 1600);
  const late = nextAgreementAction(terms, 1700);
  assert.equal(late.actor, "anyone");
  assert.match(late.action, /Release/);
});

test("in review: an open attempt waits for its panel on the actual counts, never a vote", () => {
  const waiting = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Open",
    reviewDeadline: 2000,
    quorum: 2,
    approvals: 1,
  });
  assert.equal(waiting.actor, "reviewer");
  assert.match(waiting.action, /Judge/);
  assert.doesNotMatch(waiting.note, /vote/);
  const reached = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Open",
    reviewDeadline: 2000,
    quorum: 2,
    approvals: 2,
  });
  assert.equal(reached.actor, "anyone");
  assert.match(reached.action, /Settle the claim/);
  // A one-of-one panel is exactly what it is: quorum 1 with one approval settles.
  const oneOfOne = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Open",
    reviewDeadline: 2000,
    quorum: 1,
    approvals: 1,
  });
  assert.match(oneOfOne.action, /Settle the claim/);
  // No quorum known: no optimistic settlement step is offered.
  const unknown = nextAgreementAction(fullTerms, 1000, { claimStatus: "Open" });
  assert.doesNotMatch(unknown.action, /Settle the claim/);
});

test("in review: the corrections route rebinds inside the revision deadline, never past it", () => {
  const correction = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Open",
    correctionsRequested: true,
    quorum: 2,
    approvals: 0,
  });
  assert.equal(correction.actor, "manager");
  assert.match(correction.action, /corrected attempt/);
  assert.equal(correction.due, 3_000_000);
  const past = nextAgreementAction(fullTerms, 3_000_000, {
    claimStatus: "Open",
    correctionsRequested: true,
  });
  assert.doesNotMatch(past.action ?? "", /corrected attempt/);
});

test("late reviews lapse; rejected attempts release; frozen ones wait in dispute; expired kinds release", () => {
  const expiredReview = nextAgreementAction(fullTerms, 2100, {
    claimStatus: "Open",
    reviewDeadline: 2000,
  });
  assert.match(expiredReview.action, /lapse/);
  const rejected = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Rejected",
  });
  assert.match(rejected.action, /Release/);
  assert.match(rejected.note, /releases|no mint/);
  const frozen = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Frozen",
  });
  assert.equal(frozen.action, null);
  assert.match(frozen.note, /frozen|dispute/);
});

test("approved or paid attempts are ready to settle; a consumed agreement is done", () => {
  const approved = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Approved",
    challengeWindow: 259200,
  });
  assert.equal(approved.state, "ready-to-settle");
  assert.equal(approved.actor, "anyone");
  assert.match(approved.action, /Settle the agreement/);
  assert.match(approved.note, /challenge window/);
  const paid = nextAgreementAction(fullTerms, 1000, {
    claimStatus: "Paid",
    challengeWindow: 259200,
  });
  assert.equal(paid.state, "ready-to-settle");
  // The one-time settlement candle: consumed (`terminalKind=settled`) offers no step, however fresh the claim is.
  const settledRecord = decodeAgreementRow(
    AGREEMENT_ID,
    "0x" + encodeRecord({ ...fullTerms, terminalKind: TERMINAL_SETTLED }),
  );
  const done = nextAgreementAction(settledRecord.terms, 1000);
  assert.equal(done.state, "settled");
  assert.equal(done.actor, "none");
  assert.match(done.note, /settled/);
  const consumed = nextAgreementAction(settledRecord.terms, 1000, {
    claimStatus: "Paid",
  });
  assert.equal(consumed.state, "settled");
  assert.equal(consumed.actor, "none");
  // Cancelled and expired terminal kinds are over in the same way.
  for (const kind of [TERMINAL_CANCELLED, TERMINAL_EXPIRED]) {
    const over = decodeAgreementRow(
      AGREEMENT_ID,
      "0x" + encodeRecord({ ...fullTerms, terminalKind: kind }),
    );
    assert.equal(nextAgreementAction(over.terms, 1000).actor, "none");
  }
});

test("a viewer sees their own turn; a step addressed to someone else is still true but shown to them", () => {
  const terms = { ...fullTerms, claimId: null };
  const managerSees = nextAgreementAction(terms, 1000, {
    viewer: { manager: true },
  });
  assert.equal(managerSees.actor, "none");
  assert.equal(
    managerSees.action,
    null,
    "a step not the viewer's is not offered as their turn",
  );
  const beneficiarySees = nextAgreementAction(terms, 1000, {
    viewer: { beneficiary: true },
  });
  assert.match(beneficiarySees.action, /Submit/);
  const anyoneOnAnExpiredReview = nextAgreementAction(fullTerms, 2100, {
    claimStatus: "Open",
    reviewDeadline: 2000,
    viewer: { reviewer: true },
  });
  assert.equal(anyoneOnAnExpiredReview.actor, "anyone");
  assert.match(anyoneOnAnExpiredReview.action, /lapse/);
});

test("nothing promises reservation headroom: budgets answer at acceptance", () => {
  const before = nextAgreementAction({ ...fullTerms, claimId: null }, 1000);
  assert.match(before.note, /reserved at acceptance|never promised afterwards/);
  const offered = nextAgreementAction(
    { ...fullTerms, acceptedAt: null, claimId: null },
    1000,
  );
  assert.match(offered.note, /financial moment|reserved against/);
  assert.doesNotMatch(offered.note, /headroom|available now|guaranteed/);
});
