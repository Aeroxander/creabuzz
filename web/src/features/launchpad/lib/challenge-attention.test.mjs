import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeAttention } from "./challenge-attention.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;
const WAD = 10n ** 18n;
const FOUNDER = `0x${"1".repeat(40)}`;
const COFOUNDER = `0x${"2".repeat(40)}`;
const BACKER = `0x${"3".repeat(40)}`;
const milestone = (over = {}) => ({
  index: 0,
  checkHash: `0x${"a".repeat(64)}`,
  bps: 4000,
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
const view = (milestones) => ({
  lock: `0x${"c".repeat(40)}`,
  dao: `0x${"d".repeat(40)}`,
  terms: {
    window: 7 * DAY,
    votePeriod: 5 * DAY,
    clawback: 30 * DAY,
    minRejectBps: 300,
    earliestBlock: 0,
    bondToken: null,
    bond: 0n,
    deposit: 0n,
  },
  team: [FOUNDER, COFOUNDER],
  locked: 0n,
  milestones,
  now: NOW,
});
const open = {
  open: true,
  late: false,
  objector: BACKER,
  snapshot: 1,
  voteEnds: NOW + DAY,
  deposit: 0n,
  eligible: 100n * WAD,
  rejectWeight: 0n,
  acceptWeight: 0n,
};
const kinds = (items) => items.map((i) => i.key.replace("challenge-", ""));

test("a quiet project asks nothing of anyone", () => {
  const quiet = view([
    milestone(),
    milestone({ index: 1, stage: "rejected", attempts: 1 }),
    milestone({
      index: 2,
      stage: "unlocked",
      phase: "stood",
      unlockedAt: NOW - 40 * DAY,
    }),
  ]);
  assert.deepEqual(challengeAttention(quiet, FOUNDER), []);
  assert.deepEqual(challengeAttention(quiet, BACKER), []);
});

test("a milestone that waited out its window is the team's to finish, and anyone's to", () => {
  const ready = view([
    milestone({ stage: "ready", phase: "pending", windowEnds: NOW - 1 }),
  ]);
  const [team] = challengeAttention(ready, FOUNDER);
  assert.match(team.text, /Finish it to unlock your tokens/);
  assert.equal(team.tab, "milestones");
  assert.equal(team.action, "Finish it");
  const [holder] = challengeAttention(ready, BACKER);
  assert.match(holder.text, /Anyone can finish it/);
});

test("a holder is asked to read the evidence while it waits and to vote while it is voted on, the team is not", () => {
  const waiting = view([
    milestone({
      stage: "waiting",
      phase: "pending",
      windowEnds: NOW + 3 * DAY,
    }),
  ]);
  assert.deepEqual(kinds(challengeAttention(waiting, BACKER)), ["0-read"]);
  assert.deepEqual(challengeAttention(waiting, FOUNDER), []);
  const voting = view([
    milestone({ stage: "voting", phase: "voting", objection: open }),
  ]);
  const [vote] = challengeAttention(voting, BACKER);
  assert.equal(vote.kind, "vote");
  assert.match(vote.text, /Your vote counts; the team's does not/);
  assert.deepEqual(challengeAttention(voting, COFOUNDER), []);
  const late = view([
    milestone({
      stage: "late-voting",
      phase: "stood",
      unlockedAt: NOW - DAY,
      objection: { ...open, late: true },
    }),
  ]);
  assert.deepEqual(kinds(challengeAttention(late, BACKER)), ["0-vote"]);
});

test("a vote that has ended is everyone's to settle", () => {
  const ended = view([
    milestone({
      stage: "vote-ended",
      phase: "voting",
      objection: { ...open, voteEnds: NOW - 1 },
    }),
  ]);
  for (const who of [FOUNDER, BACKER]) {
    assert.deepEqual(kinds(challengeAttention(ended, who)), ["0-settle"]);
  }
});

test("the bond is the poster's to take back once the month is over and nothing is open", () => {
  const stood = (over = {}) =>
    view([
      milestone({
        stage: "unlocked",
        phase: "stood",
        submitter: FOUNDER,
        bond: 5n * WAD,
        unlockedAt: NOW - 31 * DAY,
        ...over,
      }),
    ]);
  assert.deepEqual(kinds(challengeAttention(stood(), FOUNDER)), ["0-bond"]);
  assert.deepEqual(
    challengeAttention(stood(), COFOUNDER),
    [],
    "only whoever posted it",
  );
  assert.deepEqual(challengeAttention(stood(), BACKER), []);
  assert.deepEqual(
    challengeAttention(stood({ unlockedAt: NOW - 10 * DAY }), FOUNDER),
    [],
    "the month is not over",
  );
  assert.deepEqual(challengeAttention(stood({ bond: 0n }), FOUNDER), []);
  assert.deepEqual(
    challengeAttention(stood({ objection: { ...open, late: true } }), FOUNDER),
    [],
    "not while a vote is open",
  );
});

test("the wallet is matched whatever its case", () => {
  const ready = view([
    milestone({ stage: "ready", phase: "pending", windowEnds: NOW - 1 }),
  ]);
  assert.match(
    challengeAttention(ready, FOUNDER.toUpperCase().replace("0X", "0x"))[0]
      .text,
    /unlock your tokens/,
  );
});

test("each line says why it is shown, and what happens if nothing is done, and holders' lines say when", () => {
  const waiting = view([
    milestone({
      stage: "waiting",
      phase: "pending",
      windowEnds: NOW + 3 * DAY,
    }),
  ]);
  const [read] = challengeAttention(waiting, BACKER);
  assert.equal(read.due, NOW + 3 * DAY);
  assert.match(read.why, /hold Shares/);
  assert.match(read.ifIgnored, /If nobody objects, the milestone unlocks/);

  const voting = view([
    milestone({
      stage: "voting",
      phase: "voting",
      objection: { ...open, voteEnds: NOW + 2 * DAY },
    }),
  ]);
  const [vote] = challengeAttention(voting, BACKER);
  assert.equal(vote.due, NOW + 2 * DAY);
  assert.match(vote.ifIgnored, /milestone stands/);

  const ready = view([
    milestone({ stage: "ready", phase: "pending", windowEnds: NOW - 1 }),
  ]);
  const [finishTeam] = challengeAttention(ready, FOUNDER);
  assert.match(finishTeam.why, /on the team/);
  assert.match(finishTeam.ifIgnored, /Your tokens stay locked/);
  assert.equal(finishTeam.due, undefined, "finishing has no deadline");
  const [finishAnyone] = challengeAttention(ready, BACKER);
  assert.match(finishAnyone.ifIgnored, /team's tokens stay locked/);
});
