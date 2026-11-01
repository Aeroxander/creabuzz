import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOPIC_CLAIM_SUBMITTED,
  TOPIC_MANDATE_CREATED,
  TOPIC_PROJECT_APPROVED,
  SIGNATURES,
  addressTopic,
  decodeClaim,
  decodeClaimSubmitted,
  decodeMandateCreated,
  decodeProject,
  decodeProjectApproved,
  encodeAttest,
  encodeBind,
  encodeBindMilestone,
  encodeBond,
  encodeRequestUnbond,
  encodeUnbonds,
  encodeWithdraw,
  decodeUnbond,
  encodeCurrencyApprove,
  bondShortfall,
  decodeVerifier,
  TOPIC_VERIFIER_ACCEPTED,
  encodeCallId,
  encodeIsReviewer,
  encodeSetCheck,
  encodeSubmitPaidClaim,
  encodeSubmitRecognitionClaim,
  hashText,
  idLabel,
  idWord,
  nextStep,
  claimStatusLabel,
  cannotReachVerdict,
  canExpire,
  claimStep,
} from "./work.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const keccakSelector = (signature) =>
  bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const ID = "0x77726974652d646f637300000000000000000000000000000000000000000000";
const DAVE = "0x00000000000000000000000000000000000000da";

test("calldata equals what cast encodes for the same arguments", () => {
  assert.equal(
    encodeAttest(ID, true),
    "0x5747a6b177726974652d646f6373000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001",
  );
  assert.equal(
    encodeAttest(ID, false),
    "0x5747a6b177726974652d646f6373000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(
    encodeCallId(SIGNATURES.settle, ID),
    "0x987757dd77726974652d646f637300000000000000000000000000000000000000000000",
  );
  assert.equal(
    encodeBind(idWord("docs"), ID, DAVE),
    "0xec7742ad646f63730000000000000000000000000000000000000000000000000000000077726974652d646f63730000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000da",
  );
  // A team member files their own milestone claim into the panel: one word, as cast encodes it.
  assert.equal(
    encodeBindMilestone(ID),
    "0x3d3d949b77726974652d646f637300000000000000000000000000000000000000000000",
  );
  assert.equal(
    encodeIsReviewer(DAVE),
    "0x6c82448700000000000000000000000000000000000000000000000000000000000000da",
  );
});

test("event topics are the ones cast derives", () => {
  assert.equal(
    TOPIC_MANDATE_CREATED,
    "0x2a075deaacc4f205aa6d5c9cdadfaf7c96743415971a38b677820238f7a0965b",
  );
  assert.equal(
    TOPIC_PROJECT_APPROVED,
    "0xf1497cd6bfa2bfb0104bfb24202f1bba9987c6bef68f43aab021702bfc850adc",
  );
  assert.equal(
    TOPIC_CLAIM_SUBMITTED,
    "0x658e18ac6ae4f1c6d114c46c516b8dceef944daf6642efd1079d75259ac014b9",
  );
  assert.equal(addressTopic(DAVE), `0x${"0".repeat(62)}da`);
  assert.throws(() => addressTopic("0x1234"));
});

test("ids are labels or words, and read back as labels when they are one", () => {
  assert.equal(idWord("write-docs"), ID);
  assert.equal(idWord(ID.toUpperCase().replace("0X", "0x")), ID);
  assert.throws(() => idWord(""));
  assert.throws(() => idWord("x".repeat(33)));
  assert.throws(() => idWord("0xabcd"));
  assert.equal(idLabel(ID), "write-docs");
  const hash = `0x${"ab".repeat(32)}`;
  assert.match(idLabel(hash), /^0xabababab…abab$/);
});

test("a claim record and a project record decode from their words", () => {
  const claim = decodeClaim(
    `0x${[DAVE, 0, 0, 4, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, 9999, 1000].map(word).join("")}`,
  );
  assert.equal(claim.contributor, DAVE);
  assert.equal(claim.amount, 0n);
  assert.equal(claim.status, "Paid");
  assert.equal(claim.releasedAt, 1000);
  assert.equal(
    decodeClaim(`0x${"0".repeat(64 * 8)}`),
    null,
    "no claim under that id",
  );
  assert.equal(decodeClaim("0x1234"), null);
  assert.equal(
    decodeClaim(`0x${[DAVE, 0, 0, 9, 0, 0, 0, 0].map(word).join("")}`),
    null,
    "an unknown status is refused",
  );

  const project = decodeProject(
    `0x${[DAVE, 5, 2, 7000, `0x${"33".repeat(32)}`, 40, 25].map(word).join("")}`,
  );
  assert.equal(project.manager, DAVE);
  assert.equal(project.shareBudget, 40n);
  assert.equal(project.sharesAwarded, 25n);
  assert.equal(decodeProject(`0x${"0".repeat(64 * 7)}`), null);
});

test("the three events decode, and a log that is not one is skipped", () => {
  const mandate = decodeMandateCreated({
    topics: [
      TOPIC_MANDATE_CREATED,
      `0x${word(DAVE)}`,
      `0x${word("0x0000000000000000000000000000000000000bb1")}`,
    ],
    data: `0x${[DAVE, 0, 0, 100, 40].map(word).join("")}`,
  });
  assert.equal(mandate.dao, DAVE);
  assert.equal(mandate.mandate, "0x0000000000000000000000000000000000000bb1");
  assert.equal(mandate.shareBudget, 100n);
  assert.equal(mandate.perProjectShareCap, 40n);

  const project = decodeProjectApproved({
    topics: [TOPIC_PROJECT_APPROVED, `0x${word(ID)}`, `0x${word(DAVE)}`],
    data: `0x${[0, 40, 1_893_456_000, `0x${"44".repeat(32)}`].map(word).join("")}`,
  });
  assert.equal(project.projectId, ID);
  assert.equal(project.shareAmount, 40n);

  const claim = decodeClaimSubmitted({
    topics: [TOPIC_CLAIM_SUBMITTED, `0x${word(ID)}`],
    data: `0x${[DAVE, 0, 0, `0x${"55".repeat(32)}`].map(word).join("")}`,
  });
  assert.equal(claim.claimId, ID);
  assert.equal(claim.contributor, DAVE);

  assert.equal(decodeMandateCreated({ topics: ["0xdead"], data: "0x" }), null);
  assert.equal(
    decodeClaimSubmitted({ topics: [TOPIC_CLAIM_SUBMITTED], data: "0x" }),
    null,
  );
  assert.equal(
    decodeProjectApproved({
      topics: [TOPIC_PROJECT_APPROVED, "0x1", "0x2"],
      data: 5,
    }),
    null,
  );
});

const view = (over = {}) => ({
  id: ID,
  record: {
    contributor: DAVE,
    amount: 0n,
    stake: 0n,
    status: "Open",
    evidenceHash: "0x",
    checkHash: "0x",
    expiresAt: 0,
    releasedAt: 1000,
    ...over.record,
  },
  project: ID,
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...over,
  ...(over.record ? { record: { ...view().record, ...over.record } } : {}),
});

test("each state of a claim has one next step and one person who takes it", () => {
  const WINDOW = 259_200;
  assert.equal(nextStep(view({ project: null }), 0, WINDOW).kind, "bind");
  assert.equal(nextStep(view(), 0, WINDOW).kind, "review");
  assert.match(nextStep(view({ approvals: 1 }), 0, WINDOW).text, /1 of 2/);
  assert.equal(nextStep(view({ approvals: 2 }), 0, WINDOW).kind, "settle");
  // Approved: the payout waits for the challenge window, then belongs to the contributor.
  const approved = view({ record: { status: "Approved", releasedAt: 1000 } });
  assert.equal(nextStep(approved, 1000 + WINDOW - 1, WINDOW).kind, "none");
  assert.equal(nextStep(approved, 1000 + WINDOW, WINDOW).kind, "payout");
  // Paid: the DAO may award Shares once; not at all without a project; nothing after.
  const paid = view({ record: { status: "Paid" } });
  assert.equal(nextStep(paid, 0, WINDOW).kind, "award");
  // A claim that asked for no money is not described as paid, at any step after approval.
  assert.match(
    nextStep(paid, 0, WINDOW).text,
    /^Finished; no money was asked for\. Shareholders can vote/,
  );
  assert.doesNotMatch(nextStep(approved, 1000 + WINDOW, WINDOW).text, /pay/i);
  assert.match(
    nextStep(view({ record: { status: "Paid", amount: 5n } }), 0, WINDOW).text,
    /^Approved and paid\./,
  );
  assert.match(
    nextStep(
      view({ record: { status: "Approved", releasedAt: 1000, amount: 5n } }),
      1000 + WINDOW,
      WINDOW,
    ).text,
    /take the payment now/,
  );
  // The label the pages show for a status: a no-money claim past its window is finished, not paid.
  assert.equal(claimStatusLabel({ status: "Paid", amount: 0n }), "Finished");
  assert.equal(claimStatusLabel({ status: "Paid", amount: 5n }), "Paid");
  assert.equal(
    claimStatusLabel({ status: "Approved", amount: 0n }),
    "Approved",
  );
  assert.equal(nextStep({ ...paid, project: null }, 0, WINDOW).kind, "none");
  assert.equal(
    nextStep({ ...paid, sharesAwarded: true }, 0, WINDOW).kind,
    "none",
  );
  assert.equal(
    nextStep(view({ record: { status: "Frozen" } }), 0, WINDOW).kind,
    "none",
  );
  assert.equal(
    nextStep(view({ record: { status: "Rejected" } }), 0, WINDOW).kind,
    "none",
  );
});

test("filing a claim for recognition is cast's calldata, with the words hashed the way the CLI hashes them", () => {
  const evidence = hashText("https://example.com/pr/1");
  assert.equal(
    evidence,
    "0x59cf64d9fc220ab056956a9aa237e80755fec5c7c43134b03acc3962e30e026a",
  );
  assert.equal(
    encodeSubmitRecognitionClaim(ID, evidence),
    "0x26d3f6d477726974652d646f6373000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000059cf64d9fc220ab056956a9aa237e80755fec5c7c43134b03acc3962e30e026a",
  );
  const check = hashText("  docs merged and reviewed ");
  assert.equal(
    check,
    "0xe8164af4b3d1186a31c4eecb6012657bf68042eb1ce8130d9d766a096b0418ff",
    "surrounding space does not change the check",
  );
  assert.equal(
    encodeSetCheck(ID, check),
    "0x5b66d37a77726974652d646f637300000000000000000000000000000000000000000000e8164af4b3d1186a31c4eecb6012657bf68042eb1ce8130d9d766a096b0418ff",
  );
  assert.throws(() => encodeSetCheck("0x12", check));
});

test("a claim that asks to be paid carries its amount and stake, as cast encodes", () => {
  // cast calldata "submitClaim(bytes32,uint256,uint256,bytes32)" 0x7777… 5000000 1000000 0x8888…
  assert.equal(
    encodeSubmitPaidClaim(
      `0x${"77".repeat(32)}`,
      5_000_000n,
      1_000_000n,
      `0x${"88".repeat(32)}`,
    ),
    "0x26d3f6d4777777777777777777777777777777777777777777777777777777777777777700000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000000000000000f42408888888888888888888888888888888888888888888888888888888888888888",
  );
  assert.throws(
    () => encodeSubmitPaidClaim("0x12", 1n, 0n, `0x${"88".repeat(32)}`),
    /claim id/,
  );
  assert.throws(
    () =>
      encodeSubmitPaidClaim(
        `0x${"77".repeat(32)}`,
        -1n,
        0n,
        `0x${"88".repeat(32)}`,
      ),
    /negative/,
  );
});

test("a reviewer's bond calls equal what cast encodes, and the topic is the one cast derives", () => {
  assert.equal(
    encodeBond(50_000_000n),
    "0x9940686e0000000000000000000000000000000000000000000000000000000002faf080",
  );
  assert.equal(
    encodeCurrencyApprove(
      "0x00000000000000000000000000000000000000e1",
      50_000_000n,
    ),
    "0x095ea7b300000000000000000000000000000000000000000000000000000000000000e10000000000000000000000000000000000000000000000000000000002faf080",
  );
  assert.equal(
    TOPIC_VERIFIER_ACCEPTED,
    "0x9dd55d8f86034e4277820777f5835b19a780ee2365d14a9371446b7d8c383314",
  );
  assert.throws(() => encodeBond(0n));
  assert.throws(() => encodeCurrencyApprove("0x12", 1n));
});

test("what a reviewer still owes is the bond less what they hold, and nothing when none is asked", () => {
  assert.equal(bondShortfall(null, 0n), 0n);
  assert.equal(bondShortfall({ minBond: 50n }, 0n), 50n);
  assert.equal(bondShortfall({ minBond: 50n }, 20n), 30n);
  assert.equal(bondShortfall({ minBond: 50n }, 50n), 0n);
  assert.equal(bondShortfall({ minBond: 50n }, 80n), 0n);
});

test("verifiers(address) reads as whether they are on the panel and the bond they hold", () => {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  assert.deepEqual(decodeVerifier(`0x${w(1)}${w(50)}${w(0)}${w(0)}`), {
    active: true,
    stake: 50n,
  });
  assert.deepEqual(decodeVerifier(`0x${w(0)}${w(0)}${w(0)}${w(0)}`), {
    active: false,
    stake: 0n,
  });
  assert.deepEqual(decodeVerifier("0x"), { active: false, stake: 0n });
});

test("a claim in the milestone panel is submitted by its team member, and when it is done the Shares unlock, not an award", () => {
  const WINDOW = 604_800;
  const unbound = view({ project: null });
  assert.equal(nextStep(unbound, 0, WINDOW).who, "manager");
  const inPanel = nextStep(unbound, 0, WINDOW, true);
  assert.equal(inPanel.kind, "bind");
  assert.equal(inPanel.who, "contributor");
  assert.match(inPanel.text, /milestone panel/);
  const paid = view({ record: { status: "Paid" } });
  assert.equal(nextStep(paid, 0, WINDOW).kind, "award");
  const done = nextStep(paid, 0, WINDOW, true);
  assert.equal(done.kind, "none");
  assert.match(done.text, /unlocked/);
});

test("taking a bond back calls equal what cast encodes, and a pending unbond reads as an amount and a time", () => {
  assert.equal(
    encodeRequestUnbond(50_000_000n),
    "0x54f63b140000000000000000000000000000000000000000000000000000000002faf080",
  );
  assert.equal(encodeWithdraw(), "0x3ccfd60b");
  assert.equal(
    encodeUnbonds("0x00000000000000000000000000000000000000e1"),
    "0x653ec13400000000000000000000000000000000000000000000000000000000000000e1",
  );
  assert.throws(() => encodeRequestUnbond(0n));
  assert.throws(() => encodeUnbonds("0x12"));
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  assert.deepEqual(decodeUnbond(`0x${w(25)}${w(1_900_000_000)}`), {
    amount: 25n,
    availableAt: 1_900_000_000,
  });
  // Nothing pending, or nothing readable, is nothing: never a made-up amount.
  assert.deepEqual(decodeUnbond(`0x${w(0)}${w(0)}`), {
    amount: 0n,
    availableAt: 0,
  });
  assert.deepEqual(decodeUnbond("0x"), { amount: 0n, availableAt: 0 });
});

test("enough objections is a step anyone can take: close it as turned down (ClaimStake.settle rejects on an objection quorum)", () => {
  const WINDOW = 259_200;
  const turned = nextStep(view({ objections: 2 }), 0, WINDOW);
  assert.equal(turned.kind, "settle");
  assert.equal(turned.who, "anyone");
  assert.equal(turned.verdict, "turned-down");
  assert.match(turned.text, /turned it down/);
  // With one needed ("Let any one decide"), the first answer decides: a single turn-down can be closed at once, while
  // the other reviewer has not answered, which is what the Start form says (D145).
  const first = nextStep(
    view({ objections: 1, quorum: 1, panel: 2 }),
    0,
    WINDOW,
  );
  assert.equal(first.kind, "settle");
  assert.equal(first.verdict, "turned-down");
  // Approvals win when both reached the quorum, as in the contract (it checks approvals first).
  const both = nextStep(view({ approvals: 2, objections: 2 }), 0, WINDOW);
  assert.equal(both.verdict, "approved");
  // The waiting line counts the turn-downs too, so a split is visible.
  assert.equal(
    nextStep(view({ approvals: 1, objections: 1, quorum: 3 }), 0, WINDOW).text,
    "Waiting for reviewers: 1 of 3 approvals, 1 turned it down.",
  );
  // A claim nobody has turned down reads as it always did.
  assert.equal(
    nextStep(view({ approvals: 1 }), 0, WINDOW).text,
    "Waiting for reviewers: 1 of 2 approvals.",
  );
  // After it is closed: turned down, said plainly, with what to do next.
  const rejected = nextStep(
    view({ record: { status: "Rejected" } }),
    0,
    WINDOW,
  );
  assert.equal(rejected.kind, "none");
  assert.match(rejected.text, /^Turned down by the reviewers\./);
  assert.match(rejected.text, /new name/);
});

test("a split nobody is left to break is said plainly, and past its deadline anyone can close it as lapsed (ClaimStake.expire)", () => {
  const WINDOW = 259_200;
  const DEADLINE = 5_000;
  // Two reviewers, both must agree: one approved, one turned it down, nobody left.
  const split = view({
    approvals: 1,
    objections: 1,
    panel: 2,
    record: { expiresAt: DEADLINE },
  });
  const stuck = nextStep(split, 1_000, WINDOW);
  assert.equal(stuck.kind, "stuck");
  assert.equal(stuck.lapsesAt, DEADLINE);
  assert.match(stuck.text, /split \(1 of 2 approvals, 1 turned it down\)/);
  // With a third reviewer still to answer it is only waiting.
  assert.equal(nextStep({ ...split, panel: 3 }, 1_000, WINDOW).kind, "review");
  // Without the panel's size it is never called stuck.
  assert.equal(
    nextStep({ ...split, panel: null }, 1_000, WINDOW).kind,
    "review",
  );
  // At the deadline itself the contract still refuses (`block.timestamp <= expiresAt`); one second later anyone can close it.
  assert.equal(nextStep(split, DEADLINE, WINDOW).kind, "stuck");
  assert.equal(canExpire(split.record, DEADLINE), false);
  assert.equal(canExpire(split.record, DEADLINE + 1), true);
  const lapsed = nextStep(split, DEADLINE + 1, WINDOW);
  assert.equal(lapsed.kind, "expire");
  assert.equal(lapsed.who, "anyone");
  // A claim reviewers can still decide keeps its review step past the deadline (the contract still takes answers), and
  // says it can be closed.
  const late = nextStep(
    view({ approvals: 1, panel: 3, record: { expiresAt: DEADLINE } }),
    DEADLINE + 1,
    WINDOW,
  );
  assert.equal(late.kind, "review");
  assert.match(late.text, /deadline has passed/);
  assert.equal(
    canExpire({ status: "Approved", expiresAt: DEADLINE }, DEADLINE + 1),
    false,
  );
  // A claim nobody accepted for review lapses the same way, and a deposit is said to come back.
  const unbound = nextStep(
    view({ project: null, record: { expiresAt: DEADLINE, stake: 5n } }),
    DEADLINE + 1,
    WINDOW,
  );
  assert.equal(unbound.kind, "expire");
  assert.match(unbound.text, /deposit goes back/);
  // A verdict reached in time can still be settled after the deadline: settle does not look at it.
  assert.equal(
    nextStep(
      view({ objections: 2, record: { expiresAt: DEADLINE } }),
      DEADLINE + 1,
      WINDOW,
    ).kind,
    "settle",
  );
  const expired = nextStep(view({ record: { status: "Expired" } }), 0, WINDOW);
  assert.match(expired.text, /^Lapsed/);
  // The call is the contract's own.
  assert.equal(
    encodeCallId(SIGNATURES.expire, ID),
    `0x${keccakSelector("expire(bytes32)")}${ID.slice(2)}`,
  );
});

test("cannotReachVerdict counts the reviewers who have not answered", () => {
  assert.equal(
    cannotReachVerdict({ approvals: 1, objections: 1, quorum: 2, panel: 2 }),
    true,
  );
  assert.equal(
    cannotReachVerdict({ approvals: 1, objections: 0, quorum: 2, panel: 2 }),
    false,
  );
  assert.equal(
    cannotReachVerdict({ approvals: 1, objections: 1, quorum: 2, panel: 3 }),
    false,
  );
  assert.equal(
    cannotReachVerdict({ approvals: 2, objections: 2, quorum: 3, panel: 5 }),
    false,
  );
  assert.equal(
    cannotReachVerdict({ approvals: 2, objections: 2, quorum: 3, panel: 4 }),
    true,
  );
  assert.equal(
    cannotReachVerdict({ approvals: 1, objections: 1, quorum: 2 }),
    false,
  );
});

test("words that match no open work area are said, unless a reviewer has already answered", () => {
  const area = { record: { expiresAt: 10_000, checkHash: "0xaa" } };
  const mandate = {
    challengeWindow: 259_200,
    isMilestonePanel: false,
    closed: false,
    expiresAt: 10_000,
    projects: [area],
  };
  const unbound = view({ project: null, record: { checkHash: "0xbb" } });
  assert.equal(claimStep(unbound, mandate, 0).kind, "words");
  assert.equal(
    claimStep(
      view({ project: null, record: { checkHash: "0xaa" } }),
      mandate,
      0,
    ).kind,
    "bind",
  );
  // A reviewer's answer locks the words (ClaimStake.setCheck): the manager's step stays.
  assert.equal(
    claimStep({ ...unbound, objections: 1 }, mandate, 0).kind,
    "bind",
  );
  assert.equal(
    claimStep({ ...unbound, earlyVerdicts: 1 }, mandate, 0).kind,
    "bind",
  );
});

test("an approved claim says when it can be marked finished, and once it can, that it is ready", () => {
  const WINDOW = 604_800;
  const approved = view({ record: { status: "Approved", releasedAt: 1000 } });
  // In its wait: the step carries the moment the wait ends, so the page can name the date.
  const waiting = nextStep(approved, 1000 + WINDOW - 1, WINDOW);
  assert.equal(waiting.kind, "none");
  assert.equal(waiting.readyAt, 1000 + WINDOW);
  assert.match(
    waiting.text,
    /can be marked finished once the challenge window ends/,
  );
  // A claim that asks for money carries it too.
  assert.equal(
    nextStep(
      view({ record: { status: "Approved", releasedAt: 1000, amount: 5n } }),
      1000,
      WINDOW,
    ).readyAt,
    1000 + WINDOW,
  );
  // The wait is over: it says it is ready to mark finished.
  const ready = nextStep(approved, 1000 + WINDOW, WINDOW);
  assert.equal(ready.kind, "payout");
  assert.match(ready.text, /^Approved and ready to mark finished\./);
  assert.match(ready.text, /can mark it finished now/);
  // Only the approved wait carries a moment: other quiet states do not.
  assert.equal(
    nextStep(view({ record: { status: "Frozen" } }), 0, WINDOW).readyAt,
    undefined,
  );
});
