import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHALLENGE_STAGE_LABEL,
  CHALLENGE_STEPS,
  NO_VIEWER,
  challengeActions,
  challengeDone,
  challengeGateFor,
  challengeHeadline,
  challengePublishBlock,
  deadline,
  span,
} from "./challenge-copy.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;
const WAD = 10n ** 18n;
const TERMS = {
  window: 7 * DAY,
  votePeriod: 5 * DAY,
  clawback: 30 * DAY,
  minRejectBps: 300,
  earliestBlock: 105,
  bondToken: "0x" + "4".repeat(40),
  bond: 10n * WAD,
  deposit: WAD,
};
const m = (over = {}) => ({
  index: 0,
  checkHash: "0x" + "a".repeat(64),
  bps: 3000,
  nextWindow: 14 * DAY,
  phase: "none",
  lateObjected: false,
  attempts: 0,
  submitter: null,
  evidence: null,
  windowEnds: 0,
  unlockedAt: 0,
  bond: 0n,
  objection: null,
  stage: "not-submitted",
  ...over,
});
const objection = (over = {}) => ({
  open: true,
  late: false,
  objector: "0x" + "3".repeat(40),
  snapshot: 5,
  voteEnds: NOW + 2 * DAY,
  deposit: WAD,
  eligible: 100n * WAD,
  rejectWeight: 6n * WAD,
  acceptWeight: 2n * WAD,
  ...over,
});
const me = (over = {}) => ({
  wallet: "0x" + "9".repeat(40),
  onTeam: false,
  weight: 5n * WAD,
  voted: false,
  ...over,
});
const OPEN = { block: 1_000, now: NOW, previous: null };
const actions = (milestone, who, gate = OPEN) =>
  challengeActions(milestone, TERMS, NOW, who, gate);

test("a length of time is said the way people say it", () => {
  assert.equal(span(7 * DAY), "7 days");
  assert.equal(span(DAY), "1 day");
  assert.equal(span(36 * 3600), "36 hours");
  assert.equal(span(2 * 3600), "2 hours");
  assert.equal(span(3599), "less than 2 hours");
  assert.equal(span(-5), "less than 2 hours");
});

test("every stage has a label, and the steps behind a milestone count up", () => {
  for (const stage of Object.keys(CHALLENGE_STAGE_LABEL)) {
    assert.ok(CHALLENGE_STAGE_LABEL[stage].length > 0, stage);
    assert.ok(challengeDone(stage) <= CHALLENGE_STEPS.length, stage);
  }
  assert.equal(challengeDone("not-submitted"), 0);
  assert.equal(challengeDone("rejected"), 0);
  assert.equal(challengeDone("waiting"), 1);
  assert.equal(challengeDone("voting"), 1);
  assert.equal(challengeDone("unlocked"), 3);
});

test("only a team member can publish, and only before anything is published or after a turned-down attempt", () => {
  const team = me({ onTeam: true, weight: 0n });
  assert.deepEqual(actions(m(), team), ["publish"]);
  assert.deepEqual(actions(m({ stage: "rejected", attempts: 1 }), team), [
    "publish",
  ]);
  assert.deepEqual(actions(m(), me()), [], "a holder cannot publish");
  assert.deepEqual(actions(m(), NO_VIEWER), [], "no wallet, nothing to do");
  assert.deepEqual(
    actions(m({ stage: "waiting", phase: "pending" }), team),
    [],
  );
});

test("a holder with something to vote with can object while it waits, and the team and the empty-handed cannot", () => {
  const waiting = m({
    stage: "waiting",
    phase: "pending",
    windowEnds: NOW + DAY,
  });
  assert.deepEqual(actions(waiting, me()), ["object"]);
  assert.deepEqual(actions(waiting, me({ weight: 0n })), []);
  assert.deepEqual(actions(waiting, me({ onTeam: true, weight: 0n })), []);
  assert.deepEqual(actions(waiting, NO_VIEWER), []);
  // Once it has unlocked, one more objection is allowed for the month.
  const open = m({
    stage: "unlocked-open",
    phase: "stood",
    unlockedAt: NOW - DAY,
  });
  assert.deepEqual(actions(open, me()), ["object"]);
});

test("anyone with a wallet can finish a milestone nobody objected to, and settle a vote that has ended", () => {
  assert.deepEqual(
    actions(m({ stage: "ready", phase: "pending" }), me({ weight: 0n })),
    ["finish"],
  );
  assert.deepEqual(
    actions(
      m({
        stage: "vote-ended",
        phase: "voting",
        objection: objection({ voteEnds: NOW - 1 }),
      }),
      me({ weight: 0n }),
    ),
    ["resolve"],
  );
  assert.deepEqual(
    actions(
      m({
        stage: "late-vote-ended",
        phase: "stood",
        unlockedAt: NOW - DAY,
        objection: objection({ late: true, voteEnds: NOW - 1 }),
      }),
      me(),
    ),
    ["resolve"],
  );
  assert.deepEqual(
    actions(m({ stage: "ready", phase: "pending" }), NO_VIEWER),
    [],
  );
});

test("a vote is offered to a holder who has weight and has not voted, never to the team", () => {
  const voting = m({
    stage: "voting",
    phase: "voting",
    objection: objection(),
  });
  assert.deepEqual(actions(voting, me()), ["vote"]);
  assert.deepEqual(actions(voting, me({ voted: true })), []);
  assert.deepEqual(actions(voting, me({ weight: 0n })), []);
  assert.deepEqual(actions(voting, me({ onTeam: true, weight: 0n })), []);
  const late = m({
    stage: "late-voting",
    phase: "stood",
    unlockedAt: NOW - DAY,
    objection: objection({ late: true }),
  });
  assert.deepEqual(actions(late, me()), ["vote"]);
});

test("the bond can be taken back once the month is over and nothing is open, by anyone with a wallet", () => {
  const stood = (over = {}) =>
    m({
      stage: "unlocked",
      phase: "stood",
      bond: 10n * WAD,
      unlockedAt: NOW - 31 * DAY,
      ...over,
    });
  assert.deepEqual(actions(stood(), me({ weight: 0n })), ["release-bond"]);
  assert.deepEqual(actions(stood({ bond: 0n }), me()), []);
  assert.deepEqual(
    actions(stood({ unlockedAt: NOW - 29 * DAY }), me()),
    [],
    "the month is not over",
  );
  // A failed late objection inside the month leaves the milestone unlocked, but the bond is still held.
  assert.deepEqual(
    actions(
      stood({
        lateObjected: true,
        unlockedAt: NOW - 10 * DAY,
        objection: objection({ late: true, open: false }),
      }),
      me(),
    ),
    [],
  );
  assert.deepEqual(
    actions(stood({ objection: objection({ late: true }) }), me()),
    [],
    "not while a vote is open",
  );
  assert.deepEqual(actions(stood(), NO_VIEWER), []);
});

test("the headline says where a milestone stands and what happens next, in plain words", () => {
  const say = (milestone) => challengeHeadline(milestone, TERMS, NOW);
  assert.match(say(m()), /holders have 14 days to object/);
  assert.match(
    say(m({ stage: "rejected", attempts: 1, nextWindow: 14 * DAY })),
    /turned down the last attempt/,
  );
  assert.match(
    say(m({ stage: "waiting", phase: "pending", windowEnds: NOW + DAY })),
    /Holders can object until/,
  );
  assert.match(say(m({ stage: "ready", phase: "pending" })), /Nobody objected/);
  const voting = say(
    m({ stage: "voting", phase: "voting", objection: objection() }),
  );
  assert.match(voting, /^A holder objected\. Holders vote until /);
  assert.doesNotMatch(voting, /against/, "the tally box carries the numbers");
  assert.match(
    say(
      m({
        stage: "vote-ended",
        phase: "voting",
        objection: objection({ voteEnds: NOW - 1 }),
      }),
    ),
    /Anyone can settle it/,
  );
  assert.match(
    say(m({ stage: "unlocked-open", phase: "stood", unlockedAt: NOW - DAY })),
    /29 days more a holder can raise one more objection/,
  );
  assert.match(
    say(m({ stage: "unlocked", phase: "stood", unlockedAt: NOW - 40 * DAY })),
    /^Unlocked on /,
  );
  assert.match(
    say(
      m({
        stage: "late-voting",
        phase: "stood",
        unlockedAt: NOW - DAY,
        objection: objection({ late: true }),
      }),
    ),
    /remaining locked Shares are burned/,
  );
});

test("the team cannot publish before the lock's earliest block, or before the milestone before it is settled", () => {
  const team = me({ onTeam: true, weight: 0n });
  const first = (block) => ({ block, now: NOW, previous: null });
  assert.deepEqual(actions(m(), team, first(104)), []);
  assert.deepEqual(actions(m(), team, first(105)), ["publish"]);
  const after = (previous) => ({ block: 1_000, now: NOW, previous });
  const settled = {
    phase: "stood",
    unlockedAt: NOW - 31 * DAY,
    objection: null,
  };
  // Not unlocked yet, in its month for a late objection, a late vote still open: nothing to send.
  const stages = {
    pending: { phase: "pending", unlockedAt: 0, objection: null },
    month: { phase: "stood", unlockedAt: NOW - DAY, objection: null },
    open: {
      phase: "stood",
      unlockedAt: NOW - 31 * DAY,
      objection: objection({ late: true, voteEnds: NOW + DAY }),
    },
  };
  for (const [name, previous] of Object.entries(stages)) {
    assert.deepEqual(actions(m({ index: 1 }), team, after(previous)), [], name);
  }
  assert.deepEqual(actions(m({ index: 1 }), team, after(settled)), ["publish"]);
  // A late vote that has been settled no longer holds the next one back.
  assert.deepEqual(
    actions(
      m({ index: 1 }),
      team,
      after({
        ...settled,
        objection: objection({ open: false, late: true }),
      }),
    ),
    ["publish"],
  );
  // The last moment of the month is still inside it.
  assert.deepEqual(
    actions(
      m({ index: 1 }),
      team,
      after({
        phase: "stood",
        unlockedAt: NOW - 30 * DAY + 1,
        objection: null,
      }),
    ),
    [],
  );
  assert.deepEqual(
    actions(
      m({ index: 1 }),
      team,
      after({ phase: "stood", unlockedAt: NOW - 30 * DAY, objection: null }),
    ),
    ["publish"],
  );
  // What is said instead of the button.
  assert.match(
    challengePublishBlock(0, TERMS, first(100)),
    /opens once buyers can claim what they bought in the sale/,
  );
  assert.match(
    challengePublishBlock(2, TERMS, after(stages.pending)),
    /Milestones go in order: milestone 2 has to unlock first/,
  );
  const month = challengePublishBlock(2, TERMS, after(stages.month));
  assert.match(month, /Holders can still object to milestone 2 until /);
  assert.match(month, /Milestone 3 can be published after that/);
  assert.ok(
    month.includes(deadline(NOW - DAY + 30 * DAY)),
    "it says the exact moment the month ends",
  );
  assert.match(
    challengePublishBlock(2, TERMS, after(stages.open)),
    /Holders are still voting on an objection to milestone 2/,
  );
  // Plain words: no block numbers to compare, and no reason repeated word for word under two different refusals.
  assert.doesNotMatch(challengePublishBlock(0, TERMS, first(100)), /block|\d/);
  const voting = challengePublishBlock(2, TERMS, after(stages.open));
  assert.notEqual(voting.slice(-30), month.slice(-30));
  assert.equal(challengePublishBlock(0, TERMS, OPEN), null);
  assert.equal(challengePublishBlock(1, TERMS, after(settled)), null);
  // The other actions do not depend on it.
  assert.deepEqual(
    actions(m({ stage: "ready", phase: "pending" }), me(), {
      block: 1,
      now: NOW,
      previous: stages.pending,
    }),
    ["finish"],
  );
});

test("the gate for a milestone is built from the read of the one before it, and from a fresher block and clock when there is one", () => {
  const view = {
    block: 500,
    now: NOW,
    milestones: [
      m({ index: 0, phase: "stood", unlockedAt: NOW - DAY }),
      m({ index: 1 }),
    ],
  };
  assert.deepEqual(challengeGateFor(view, 0), {
    block: 500,
    now: NOW,
    previous: null,
  });
  assert.equal(challengeGateFor(view, 1).previous.unlockedAt, NOW - DAY);
  assert.equal(
    challengeGateFor(view, 1, { block: 900, now: NOW + 60 }).block,
    900,
  );
  assert.equal(
    challengeGateFor(view, 1, { block: 900, now: NOW + 60 }).now,
    NOW + 60,
  );
  // A milestone the read does not have is not settled.
  assert.equal(challengeGateFor(view, 5).previous.phase, "none");
});

test("an unlocked milestone says how it got through: nobody objected is not the same as holders having looked", () => {
  const say = (milestone) => challengeHeadline(milestone, TERMS, NOW);
  const stood = (extra) =>
    m({
      stage: "unlocked",
      phase: "stood",
      unlockedAt: NOW - 40 * DAY,
      ...extra,
    });
  assert.match(say(stood()), /Unlocked on .*Nobody objected\./);
  // An objection that failed before the unlock.
  const failed = objection({
    open: false,
    late: false,
    rejectWeight: WAD,
    acceptWeight: 3n * WAD,
  });
  assert.match(
    say(stood({ objection: failed })),
    /A holder objected, but the objection did not stand\./,
  );
  // The lock still holds the objection that sent an earlier attempt back: a retry nobody objected to is not "objected".
  const earlier = objection({
    open: false,
    late: false,
    voteEnds: NOW - 60 * DAY, // before this attempt began (its window ended 41 days ago and ran 14)
    rejectWeight: 60n * WAD,
    acceptWeight: WAD,
  });
  assert.match(
    say(
      stood({
        attempts: 1,
        windowEnds: NOW - 41 * DAY,
        nextWindow: 14 * DAY,
        objection: earlier,
      }),
    ),
    /Nobody objected\./,
  );
  // A late objection that did not stand, and one that was upheld (and burned what was still locked).
  assert.match(
    say(
      stood({
        lateObjected: true,
        objection: { ...failed, late: true },
      }),
    ),
    /A holder objected later, but the objection did not stand\./,
  );
  const upheld = say(
    stood({
      lateObjected: true,
      objection: objection({
        open: false,
        late: true,
        rejectWeight: 60n * WAD,
        acceptWeight: WAD,
      }),
    }),
  );
  assert.match(
    upheld,
    /holders upheld it: the team's remaining locked Shares were burned/,
  );
  // Still inside the month, it says how it got through and what can still happen.
  const inMonth = say(
    m({ stage: "unlocked-open", phase: "stood", unlockedAt: NOW - DAY }),
  );
  assert.match(inMonth, /Nobody objected\. For 29 days more/);
});

test("a deadline is an exact moment with its time zone", () => {
  const text = deadline(1_800_000_000);
  assert.match(text, /\d{1,2}:\d{2}/);
  assert.match(text, /(AM|PM)/);
  assert.match(text, /[A-Z]{2,5}|GMT[+-]\d+/, "a time zone is named");
  const headline = challengeHeadline(
    m({ stage: "waiting", phase: "pending", windowEnds: 1_800_000_000 }),
    TERMS,
    NOW,
  );
  assert.ok(headline.includes(text), "the headline says the exact time");
});
