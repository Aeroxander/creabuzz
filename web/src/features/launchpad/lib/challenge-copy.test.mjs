import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHALLENGE_STAGE_LABEL,
  CHALLENGE_STEPS,
  NO_VIEWER,
  challengeActions,
  challengeDone,
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
const shares = (units) => `${units / WAD} Shares`;
const OPEN = { block: 1_000, previousStood: true };
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
  const say = (milestone) => challengeHeadline(milestone, TERMS, NOW, shares);
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
  assert.match(voting, /6 Shares against, 2 Shares in favour/);
  assert.match(voting, /at least 3% of what could vote/);
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
    /remaining locked tokens are burned/,
  );
});

test("the team cannot publish before the lock's earliest block, or before the milestone before it has stood", () => {
  const team = me({ onTeam: true, weight: 0n });
  assert.deepEqual(actions(m(), team, { block: 104, previousStood: true }), []);
  assert.deepEqual(actions(m(), team, { block: 105, previousStood: true }), [
    "publish",
  ]);
  assert.deepEqual(
    actions(m({ index: 1 }), team, { block: 1_000, previousStood: false }),
    [],
  );
  assert.deepEqual(
    actions(m({ index: 1 }), team, { block: 1_000, previousStood: true }),
    ["publish"],
  );
  // What is said instead of the button.
  assert.match(
    challengePublishBlock(0, TERMS, { block: 100, previousStood: true }),
    /opens when the buyers can claim, at block 105. The chain is at block 100/,
  );
  assert.match(
    challengePublishBlock(2, TERMS, { block: 1_000, previousStood: false }),
    /Milestones go in order: milestone 2 has to unlock first/,
  );
  assert.equal(challengePublishBlock(0, TERMS, OPEN), null);
  // The other actions do not depend on it.
  assert.deepEqual(
    actions(m({ stage: "ready", phase: "pending" }), me(), {
      block: 1,
      previousStood: false,
    }),
    ["finish"],
  );
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
    shares,
  );
  assert.ok(headline.includes(text), "the headline says the exact time");
});
