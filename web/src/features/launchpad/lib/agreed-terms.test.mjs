import assert from "node:assert/strict";
import test from "node:test";

import {
  AGREEMENTS_SPLIT_ALL,
  AGREEMENT_TERMINALS,
  AGREE_SELECTORS,
  decodeAgreementRow,
  deliverableSlotKey,
  agreementIdOf,
  encodeAcceptAgreement,
  splitHashOf,
} from "@creaton/core/launchpad/agreements.ts";
import { ZERO_WORD, hashText } from "@creaton/core/launchpad/work.ts";
import {
  acceptancePlan,
  agreedQuantityWords,
  agreementStateWords,
  periodWords,
  proposalPlan,
  releaseCall,
  reviewerPolicyWords,
  settlementCall,
  wordsMatchHash,
} from "./agreed-terms.ts";

const MANDATE = "0x00000000000000000000000000000000000000d1";
const DAO = "0x00000000000000000000000000000000000000da";
const MANAGER = "0x00000000000000000000000000000000000000d2";
const BENEFICIARY = "0x00000000000000000000000000000000000000a1";
const COAUTHOR = "0x00000000000000000000000000000000000000a2";
const PROJECT = `0x${"ab".repeat(32)}`;
const POLICY = `0x${"0".repeat(24)}${MANDATE.slice(2)}`;
const CRITERIA = `0x${"c0".repeat(32)}`;
const ONE_SHARE = 10n ** 18n;
const word = (n) => n.toString(16).padStart(64, "0");

function draft(over = {}) {
  return {
    mandate: MANDATE,
    projectId: PROJECT,
    manager: MANAGER,
    projectExpiresAt: 2_000_000,
    now: 1_000,
    beneficiary: BENEFICIARY,
    shares: 10n * ONE_SHARE,
    workDeadline: 1_600_000n,
    deliverable: "the first guide",
    policyRef: POLICY,
    ...over,
  };
}

test("a quantity is exact, in Shares, and never rounded", () => {
  assert.equal(agreedQuantityWords(ONE_SHARE), "1");
  assert.equal(agreedQuantityWords(1n), "0.000000000000000001");
  assert.equal(agreedQuantityWords(12n * ONE_SHARE + ONE_SHARE / 2n), "12.5");
  assert.equal(
    agreedQuantityWords(1_234_567n * ONE_SHARE),
    "1,234,567",
    "the whole part is grouped for reading",
  );
  assert.throws(() => agreedQuantityWords(0n));
  assert.throws(() => agreedQuantityWords(-1n));
});

test("a window says how long it is, in words", () => {
  assert.equal(periodWords(7 * 86_400), "7 days");
  assert.equal(periodWords(86_400), "1 day");
  assert.equal(periodWords(14 * 86_400), "14 days");
  assert.equal(periodWords(36 * 3_600), "1 day");
  assert.equal(periodWords(3_600), "1 hour");
  assert.equal(periodWords(120), "2 minutes");
});

test("words are the ones a hash commits to, or they are not", () => {
  assert.equal(
    wordsMatchHash("  a guide merged  ", hashText("a guide merged")),
    true,
  );
  assert.equal(wordsMatchHash("a guide merged", hashText("another")), false);
  assert.equal(wordsMatchHash("", hashText("")), false);
  assert.equal(wordsMatchHash("a guide merged", "not-a-word"), false);
});

test("a proposal with no split commits the zero word, never an empty-list hash", () => {
  const plan = proposalPlan(draft());
  assert.equal(plan.kind, "ok");
  assert.equal(plan.splitHash, ZERO_WORD);
  assert.equal(plan.slot, deliverableSlotKey("the first guide"));
  assert.equal(plan.agreementId, agreementIdOf(PROJECT, plan.slot));
  assert.equal(plan.call.to, MANDATE, "the mandate takes the proposal");
  assert.ok(plan.call.data.startsWith(AGREE_SELECTORS.propose));
});

test("a proposal's split is the exact declaration the acceptance must reproduce", () => {
  const plan = proposalPlan(
    draft({
      coauthors: [{ address: COAUTHOR, percentBps: 3_000 }],
    }),
  );
  assert.equal(plan.kind, "ok");
  assert.equal(
    plan.splitHash,
    splitHashOf([BENEFICIARY, COAUTHOR], [7_000, 3_000]),
    "the beneficiary takes the remainder, first in the list",
  );
  assert.equal(AGREEMENTS_SPLIT_ALL, 10_000);
});

test("terms that could never be accepted are refused before the wallet", () => {
  assert.equal(
    proposalPlan(draft({ beneficiary: MANAGER })).kind,
    "problem",
    "a manager cannot reward themselves",
  );
  assert.equal(
    proposalPlan(draft({ beneficiary: "not-an-address" })).kind,
    "problem",
  );
  assert.equal(
    proposalPlan(draft({ mandate: "0x1234" })).kind,
    "problem",
    "a budget address that is not one",
  );
  assert.equal(proposalPlan(draft({ shares: 0n })).kind, "problem");
  assert.equal(
    proposalPlan(draft({ shares: 1n << 96n })).kind,
    "problem",
    "past what the Shares token can hold",
  );
  assert.equal(
    proposalPlan(draft({ workDeadline: 1_000n })).kind,
    "problem",
    "a deadline that already passed",
  );
  assert.equal(
    proposalPlan(draft({ workDeadline: 2_000_001n })).kind,
    "problem",
    "a deadline past the work area's own end",
  );
  assert.equal(proposalPlan(draft({ deliverable: "   " })).kind, "problem");
  assert.equal(
    proposalPlan(
      draft({ coauthors: [{ address: COAUTHOR, percentBps: 10_000 }] }),
    ).kind,
    "problem",
    "the beneficiary keeps a part",
  );
  assert.equal(
    proposalPlan(
      draft({
        coauthors: [
          { address: COAUTHOR, percentBps: 3_000 },
          { address: COAUTHOR, percentBps: 2_000 },
        ],
      }),
    ).kind,
    "problem",
    "one person named twice",
  );
  assert.equal(
    proposalPlan(
      draft({ coauthors: [{ address: MANAGER, percentBps: 3_000 }] }),
    ).kind,
    "problem",
    "the manager never takes part of the reservation",
  );
  // A part smaller than one whole unit cannot be promised.
  assert.equal(
    proposalPlan(
      draft({
        shares: 1n,
        coauthors: [{ address: COAUTHOR, percentBps: 5_000 }],
      }),
    ).kind,
    "problem",
  );
});

/** An agreement record exactly as the mandate's getter answers it. */
function termsOf({ splitHash = 0n, acceptedAt = 0n } = {}) {
  const id = agreementIdOf(PROJECT, deliverableSlotKey("the first guide"));
  const hex =
    "0x" +
    [
      word(BigInt(PROJECT)),
      word(BigInt(BENEFICIARY)),
      word(10n * ONE_SHARE),
      word(BigInt(CRITERIA)),
      word(BigInt(POLICY)),
      word(acceptedAt),
      word(7n * 86_400n),
      word(1_600_000n),
      word(2_809_600n),
      word(0n),
      word(0n),
      word(0n),
      word(splitHash),
    ].join("");
  const decoded = decodeAgreementRow(id, hex);
  assert.equal(decoded.kind, "present");
  return { id, terms: decoded.terms };
}

test("the record reads in the contract's own words", () => {
  const { terms } = termsOf();
  assert.equal(terms.terminal, AGREEMENT_TERMINALS[0]);
  assert.equal(terms.shares, 10n * ONE_SHARE);
  assert.equal(terms.beneficiary, BENEFICIARY);
  assert.equal(terms.acceptedAt, null, "an offer nobody accepted yet");
  assert.equal(terms.splitHash, ZERO_WORD);
});

test("accepting with no split declares none; the call is the mandate's", () => {
  const { id, terms } = termsOf();
  const plan = acceptancePlan({
    terms,
    mandate: MANDATE,
    split: { kind: "none" },
    manager: MANAGER,
    wallet: BENEFICIARY,
  });
  assert.equal(plan.kind, "ok");
  assert.equal(plan.call.to, MANDATE);
  assert.ok(plan.call.data.startsWith(AGREE_SELECTORS.accept));
  assert.equal(
    plan.call.data,
    encodeAcceptAgreement({
      agreementId: id,
      shares: 10n * ONE_SHARE,
      parties: [],
      percentages: [],
      governance: { beneficiary: BENEFICIARY, manager: MANAGER },
    }),
  );
});

test("a declared split is reproduced exactly; a mismatched one sends nothing", () => {
  const committed = splitHashOf([BENEFICIARY, COAUTHOR], [7_000, 3_000]);
  const { id, terms } = termsOf({ splitHash: BigInt(committed) });
  const split = {
    kind: "declared",
    parties: [BENEFICIARY, COAUTHOR],
    percentages: [7_000, 3_000],
  };
  const plan = acceptancePlan({
    terms,
    mandate: MANDATE,
    split,
    manager: MANAGER,
    wallet: BENEFICIARY,
  });
  assert.equal(plan.kind, "ok");
  assert.equal(
    plan.call.data,
    encodeAcceptAgreement({
      agreementId: id,
      shares: 10n * ONE_SHARE,
      parties: [BENEFICIARY, COAUTHOR],
      percentages: [7_000, 3_000],
      governance: { beneficiary: BENEFICIARY, manager: MANAGER },
    }),
  );
  // A different declaration than the one committed is refused.
  const altered = acceptancePlan({
    terms,
    mandate: MANDATE,
    split: {
      kind: "declared",
      parties: [BENEFICIARY, COAUTHOR],
      percentages: [6_000, 4_000],
    },
    manager: MANAGER,
    wallet: BENEFICIARY,
  });
  assert.equal(altered.kind, "problem");
  // So is a split nobody could read, and a wallet the offer does not name.
  assert.equal(
    acceptancePlan({
      terms,
      mandate: MANDATE,
      split: { kind: "unreadable", reason: "no answer" },
      manager: MANAGER,
      wallet: BENEFICIARY,
    }).kind,
    "problem",
  );
  assert.equal(
    acceptancePlan({
      terms,
      mandate: MANDATE,
      split,
      manager: MANAGER,
      wallet: COAUTHOR,
    }).kind,
    "problem",
  );
  assert.equal(
    acceptancePlan({
      terms,
      mandate: "not-an-address",
      split: { kind: "none" },
      manager: MANAGER,
      wallet: BENEFICIARY,
    }).kind,
    "problem",
    "a budget address that is not one",
  );
});

test("settlement is the DAO's call, release is the mandate's", () => {
  const id = agreementIdOf(PROJECT, deliverableSlotKey("the first guide"));
  const settle = settlementCall({
    dao: DAO,
    mandate: MANDATE,
    agreementId: id,
  });
  assert.equal(settle.to, DAO);
  assert.ok(settle.data.startsWith(AGREE_SELECTORS.settle));
  const release = releaseCall({ mandate: MANDATE, agreementId: id });
  assert.equal(release.to, MANDATE);
  assert.ok(release.data.startsWith(AGREE_SELECTORS.release));
});

test("the panel is named as it stands, and an unreadable one is never a number", () => {
  assert.match(
    reviewerPolicyWords({ quorum: 2, panel: 3 }),
    /2 of the 3 reviewers/,
  );
  assert.match(
    reviewerPolicyWords({ quorum: 2, panel: 3 }),
    /voluntary and unpaid/,
  );
  assert.match(reviewerPolicyWords({ quorum: 2, panel: 0 }), /2 reviewers/);
  const unreadable = reviewerPolicyWords({
    quorum: 2,
    panel: 3,
    unreadable: true,
  });
  assert.match(unreadable, /could not be read/);
  assert.doesNotMatch(unreadable, /2 of the 3/);
});

test("each record state reads as what it is", () => {
  assert.match(agreementStateWords("offered"), /waiting/);
  assert.match(agreementStateWords("agreed"), /set aside/);
  assert.match(agreementStateWords("settled"), /Settled/);
  assert.match(agreementStateWords("expired"), /released/);
});
