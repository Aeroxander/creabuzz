import assert from "node:assert/strict";
import test from "node:test";

import {
  agreementIdOf,
  decodeAgreementRow,
  decodeSplitsRow,
  deliverableSlotKey,
  splitHashOf,
  AGREEMENTS_MAX_SPLIT_PARTIES,
  AGREEMENTS_SPLIT_ALL,
} from "@creaton/core/launchpad/agreements.ts";
import { bindCandidates } from "./agreed-submission.ts";
import {
  approvedQuorumStands,
  awardVoteBlockedOn,
  capabilityHeadline,
  correctionsOfEvents,
  deliverableMatches,
  descriptorsOfEvents,
  laneStep,
  reviewBlockedPayees,
  settlementFigures,
} from "./agreed-lane.ts";

const word = (n) => n.toString(16).padStart(64, "0");
const PROJECT = `0x${"ab".repeat(32)}`;
const SLOT = deliverableSlotKey("the first guide");
const AGREEMENT = agreementIdOf(PROJECT, SLOT);
const MANDATE = "0x00000000000000000000000000000000000000d1";
const BENEFICIARY = "0x00000000000000000000000000000000000000a1";
const COAUTHOR = "0x00000000000000000000000000000000000000a2";
const MANAGER = "0x00000000000000000000000000000000000000d2";
const CLAIM = `0x${"c1".repeat(32)}`;
const CRITERIA = `0x${"c0".repeat(32)}`;
const CHALLENGE = 7 * 86_400;

/** An agreement record exactly as the mandate's getter answers it. */
function rowHex({
  acceptedAt = 500,
  terminal = 0,
  claimId = CLAIM,
  attempts = 1,
  shares = 50n,
  workDeadline = 1600,
  revisionDeadline = 3_000_000,
  splitHash = null,
} = {}) {
  return (
    "0x" +
    word(BigInt(PROJECT)) +
    word(BigInt(BENEFICIARY)) +
    word(shares) +
    word(BigInt(CRITERIA)) +
    word(0n) + // policyRef
    word(BigInt(acceptedAt)) +
    word(7n * 86_400n) + // review period
    word(BigInt(workDeadline)) +
    word(BigInt(revisionDeadline)) +
    word(claimId === null ? 0n : BigInt(claimId)) +
    word(BigInt(terminal)) +
    word(BigInt(attempts)) +
    word(splitHash === null ? 0n : BigInt(splitHash))
  );
}

const CLAIM_VIEW = {
  record: { status: "Open", releasedAt: 0, expiresAt: 2_000 },
  approvals: 0,
  objections: 0,
};

test("capability words keep a failed read apart from a legacy deployment", () => {
  assert.match(capabilityHeadline("unsupported"), /version/);
  // A version getter that refuses is never read as "before agreed rewards".
  assert.doesNotMatch(capabilityHeadline("unreadable"), /before|legacy/);
  assert.match(capabilityHeadline("unreadable"), /could not read/i);
  assert.match(capabilityHeadline("known-legacy"), /the way it always has/);
});

function row(hex) {
  const decoded = decodeAgreementRow(AGREEMENT, hex);
  // The read-side row carries the split getter's answer beside the record;
  // the test gives the committed hash where the record carries one.
  return {
    id: AGREEMENT,
    ...decoded,
    ...(decoded.kind === "present" &&
    decoded.terms.splitHash !== `0x${"0".repeat(64)}`
      ? {
          split: {
            kind: "declared",
            parties: decodeSplitsRow(AGREEMENT, splitHex()).parties,
            percentages: decodeSplitsRow(AGREEMENT, splitHex()).percentages,
          },
        }
      : decoded.kind === "present"
        ? { split: { kind: "none" } }
        : {}),
  };
}

/** One declared split: the beneficiary plus a coauthor, exact. */
function splitHex() {
  return (
    "0x" +
    word(BigInt(BENEFICIARY)) +
    word(BigInt(COAUTHOR)) +
    word(0n) +
    word(0n) +
    word(3300n) +
    word(6700n) +
    word(0n) +
    word(0n) +
    word(2n)
  );
}

test("the record's own next steps, one at a time", () => {
  const offered = row(rowHex({ acceptedAt: 0, claimId: null }));
  const accept = laneStep(offered, null, {
    now: 1000,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
    viewer: { beneficiary: true },
  });
  assert.equal(accept.kind, "accept");
  assert.match(
    accept.note,
    /Accepting is the financial moment|financial moment/,
  );

  // Past the deadline the offer comes off the board.
  const stale = laneStep(offered, null, {
    now: 1600,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
  });
  assert.equal(stale.kind, "release");

  const agreed = row(rowHex({ claimId: null }));
  const submit = laneStep(agreed, null, {
    now: 1000,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
    viewer: { beneficiary: true },
  });
  assert.equal(submit.kind, "submit");
  const lateWork = laneStep(agreed, null, {
    now: 1600,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
  });
  assert.equal(lateWork.kind, "release");
});

test("an open attempt waits for the panel; quorum hands the settle to anyone", () => {
  const instant = row(rowHex());
  const waiting = laneStep(instant, CLAIM_VIEW, {
    now: 1000,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
  });
  assert.equal(waiting.kind, "review");
  const reached = laneStep(
    instant,
    { ...CLAIM_VIEW, approvals: 2 },
    {
      now: 1000,
      quorum: 2,
      challengeWindow: CHALLENGE,
      correctionsRequested: false,
    },
  );
  assert.equal(reached.kind, "settle-claim");
});

test("corrections are the non-final route, and never a turn-down", () => {
  const instant = row(rowHex());
  const corrections = laneStep(instant, CLAIM_VIEW, {
    now: 1000,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: true,
    viewer: { beneficiary: true },
  });
  assert.equal(corrections.kind, "corrections");
  assert.match(corrections.note, /corrected attempt|corrections/i);
  // The route dies at the revision deadline; the frozen case stays frozen.
  const pastRevision = laneStep(instant, CLAIM_VIEW, {
    now: 3_000_000,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: true,
  });
  assert.equal(pastRevision.kind, "info");
});

test("a frozen attempt awards nothing and names the dispute", () => {
  const instant = row(rowHex());
  const frozen = laneStep(
    instant,
    {
      ...CLAIM_VIEW,
      record: { status: "Frozen", releasedAt: 0, expiresAt: 0 },
    },
    {
      now: 1000,
      quorum: 2,
      challengeWindow: CHALLENGE,
      correctionsRequested: false,
    },
  );
  assert.equal(frozen.kind, "info");
  assert.match(frozen.note, /frozen|dispute/i);
});

test("review expiry says the attempt lapsed; rejections free the reservation", () => {
  const instant = row(rowHex());
  const lapsed = laneStep(instant, CLAIM_VIEW, {
    now: 2_100,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
  });
  assert.match(lapsed.note, /lapse/i);
  const unapproved = laneStep(
    instant,
    {
      ...CLAIM_VIEW,
      record: { status: "Rejected", releasedAt: 0, expiresAt: 0 },
    },
    {
      now: 1000,
      quorum: 2,
      challengeWindow: CHALLENGE,
      correctionsRequested: false,
    },
  );
  assert.equal(unapproved.kind, "release");
});

test("settlement waits out the challenge window, then anyone can settle", () => {
  const instant = row(rowHex());
  const releasedAt = 90_000;
  const inside = laneStep(
    instant,
    {
      ...CLAIM_VIEW,
      record: { status: "Approved", releasedAt, expiresAt: 2_000 },
    },
    {
      now: releasedAt + 100,
      quorum: 2,
      challengeWindow: CHALLENGE,
      correctionsRequested: false,
    },
  );
  assert.equal(inside.kind, "wait");
  assert.equal(inside.due, releasedAt + CHALLENGE);
  const ready = laneStep(
    instant,
    {
      ...CLAIM_VIEW,
      record: { status: "Approved", releasedAt, expiresAt: 2_000 },
    },
    {
      now: releasedAt + CHALLENGE,
      quorum: 2,
      challengeWindow: CHALLENGE,
      correctionsRequested: false,
    },
  );
  assert.equal(ready.kind, "settle-agreement");
  const paid = laneStep(
    instant,
    {
      ...CLAIM_VIEW,
      record: { status: "Paid", releasedAt, expiresAt: 2_000 },
    },
    {
      now: releasedAt,
      quorum: 2,
      challengeWindow: CHALLENGE,
      correctionsRequested: false,
    },
  );
  assert.equal(paid.kind, "settle-agreement");
  const done = laneStep(row(rowHex({ terminal: 1 })), null, {
    now: 1000,
    quorum: 2,
    challengeWindow: CHALLENGE,
    correctionsRequested: false,
  });
  assert.equal(done.kind, "done");
});

test("finishing an agreed attempt is offered only when it can only approve", () => {
  assert.equal(
    approvedQuorumStands({ approvals: 2, objections: 0, quorum: 2 }),
    true,
  );
  assert.equal(
    approvedQuorumStands({ approvals: 1, objections: 0, quorum: 2 }),
    false,
    "no approval quorum yet",
  );
  assert.equal(
    approvedQuorumStands({ approvals: 2, objections: 2, quorum: 2 }),
    false,
    "an objection quorum stands: settling here can turn it down and slash",
  );
  assert.equal(
    approvedQuorumStands({ approvals: 2, objections: 0, quorum: 0 }),
    false,
    "a panel with no quorum has no finish",
  );
});

test("an award vote is refused on every agreement-bound attempt, superseded too", () => {
  const lane = {
    boundClaims: new Map([[`0x${"01".repeat(32)}`, AGREEMENT]]),
    agreements: [{ row: row(rowHex()) }],
  };
  // The current attempt is bound.
  assert.equal(awardVoteBlockedOn(lane, CLAIM), true);
  // A superseded attempt the reads confirmed is bound: blocked as well.
  assert.equal(awardVoteBlockedOn(lane, `0x${"01".repeat(32)}`), true);
  // A claim with no known binding: not blocked, and the chain stays the referee.
  assert.equal(awardVoteBlockedOn(lane, `0x${"02".repeat(32)}`), null);
});

test("the review panel excludes the people the settlement pays, split included", () => {
  const parties = [BENEFICIARY, COAUTHOR];
  const committed = row(
    rowHex({ splitHash: splitHashOf([BENEFICIARY, COAUTHOR], [3300, 6700]) }),
  );
  // Three keys are not three people: one manager, one beneficiary shown twice.
  assert.notEqual(MANAGER.toLowerCase(), BENEFICIARY);
  const payees = reviewBlockedPayees(
    { agreements: [{ row: committed }] },
    CLAIM,
  );
  assert.deepEqual(
    payees.map((p) => p.toLowerCase()),
    parties.map((p) => p.toLowerCase()),
  );
  assert.equal(payees.includes(MANAGER), false);
  // The whole quantity is exactly what the record reserved.
  const figures = settlementFigures(committed);
  assert.equal(
    figures.reduce((a, b) => a + b.quantity, 0n),
    50n,
  );
  assert.equal(figures[0].address.toLowerCase(), BENEFICIARY.toLowerCase());
  // A no-split record has the beneficiary alone, exact.
  const whole = settlementFigures({
    ...row(rowHex()),
    split: { kind: "none" },
  });
  assert.deepEqual(whole, [{ address: BENEFICIARY, quantity: 50n }]);
});

test("hundreds of percents equal the whole; the split rule holds", () => {
  assert.equal(AGREEMENTS_SPLIT_ALL, 10_000);
  assert.equal(AGREEMENTS_MAX_SPLIT_PARTIES, 4);
});

test("the deliverable words hash to the agreement the record carries", () => {
  const conduct = row(rowHex());
  assert.equal(deliverableMatches(conduct.terms, "the first guide"), true);
  assert.equal(deliverableMatches(conduct.terms, "the second guide"), false);
});

test("published offer words are keyed by their agreement, newest wins", () => {
  const event = (id, createdAt, deliverable) => ({
    id,
    pubkey: MANAGER,
    created_at: createdAt,
    content: JSON.stringify({
      title: `Agreed work: ${deliverable}`,
      body: deliverable,
      agreement: {
        id: AGREEMENT,
        mandate: MANDATE,
        projectId: PROJECT,
        deliverable,
      },
    }),
  });
  const events = [
    event("e1", 200, "the first guide, v1"),
    event("e2", 300, "the first guide, v2"),
    {
      id: "e3",
      pubkey: MANAGER,
      created_at: 400,
      content: JSON.stringify({
        title: "An update on other work",
        body: "text",
      }),
    },
  ];
  const terms = descriptorsOfEvents(events, (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
  assert.equal(terms.length, 1);
  assert.equal(terms[0].deliverable, "the first guide, v2");
  assert.equal(terms[0].agreementId, AGREEMENT);
  // Words that do not name a reachable agreement are refused, never shown.
  assert.equal(
    terms.some((t) => t.eventId === "e3"),
    false,
  );
});

test("published corrections words are keyed to their claim, never a verdict", () => {
  const event = {
    id: "e9",
    pubkey: MANAGER,
    created_at: 500,
    content: JSON.stringify({
      agreementCorrections: {
        claimId: CLAIM,
        mandate: MANDATE,
        agreementId: AGREEMENT,
        reason: "Please compare against the newest guide",
      },
    }),
  };
  const corrections = correctionsOfEvents(
    [event, { ...event, content: "{ broken" }],
    (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  );
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].claimId, CLAIM);
  assert.match(corrections[0].reason, /newest guide/);
});

test("a submitted attempt waits for a bind that the work would accept", () => {
  // An offer whose first attempt has not been bound yet (the record names no
  // claim) is the one that matches its beneficiary's freshly-filed claim.
  const committed = row(rowHex({ claimId: null, attempts: 0 }));
  const candidate = bindCandidates({
    row: committed,
    claims: [
      {
        id: CLAIM,
        project: null,
        record: {
          contributor: BENEFICIARY,
          amount: 0n,
          status: "Open",
          checkHash: CRITERIA,
        },
      },
      // Wrong person, bound elsewhere, uses money, or states other words.
      {
        id: `0x${"02".repeat(32)}`,
        project: null,
        record: {
          contributor: MANAGER,
          amount: 0n,
          status: "Open",
          checkHash: CRITERIA,
        },
      },
      {
        id: `0x${"03".repeat(32)}`,
        project: PROJECT,
        record: {
          contributor: BENEFICIARY,
          amount: 0n,
          status: "Open",
          checkHash: CRITERIA,
        },
      },
      {
        id: `0x${"04".repeat(32)}`,
        project: null,
        record: {
          contributor: BENEFICIARY,
          amount: 5n,
          status: "Open",
          checkHash: CRITERIA,
        },
      },
    ],
  });
  assert.deepEqual(
    candidate.map((c) => c.id),
    [CLAIM],
  );
});
