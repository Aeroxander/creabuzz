import assert from "node:assert/strict";
import { test } from "node:test";
import { selectorOf } from "./evmAbi.ts";
import {
  CHALLENGE_SIGNATURES,
  MAX_CHALLENGE_MILESTONES,
  SELECTOR_CHALLENGE_FINISH,
  SELECTOR_CHALLENGE_OBJECT,
  SELECTOR_CHALLENGE_RELEASE_BOND,
  SELECTOR_CHALLENGE_RESOLVE,
  SELECTOR_CHALLENGE_SUBMIT,
  SELECTOR_CHALLENGE_VOTE,
  challengeStage,
  challengeTrancheShare,
  encodeChallengeFinish,
  encodeChallengeObject,
  encodeChallengeReleaseBond,
  encodeChallengeResolve,
  encodeChallengeSubmit,
  encodeChallengeVote,
  findChallengeLock,
  objectionCarries,
  readChallengeLock,
  readChallengeVoter,
} from "./milestoneChallenge.ts";

const DAO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCK = "0xcccccccccccccccccccccccccccccccccccccccc";
const FOUNDER = "0x1111111111111111111111111111111111111111";
const COFOUNDER = "0x2222222222222222222222222222222222222222";
const BACKER = "0x3333333333333333333333333333333333333333";
const USDC = "0x4444444444444444444444444444444444444444";
const CHECK_A = `0x${"a1".repeat(32)}`;
const CHECK_B = `0x${"b2".repeat(32)}`;
const EVIDENCE = `0x${"ab".repeat(32)}`;
const WAD = 10n ** 18n;
const NOW = 1_800_000_000;
const DAY = 86_400;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const hex = (...words) => `0x${words.map(word).join("")}`;

test("the selectors are the contract's, as cast computes them", () => {
  // cast sig "<signature>"
  assert.equal(SELECTOR_CHALLENGE_SUBMIT, "0x2ecea788");
  assert.equal(SELECTOR_CHALLENGE_FINISH, "0xd353a1cb");
  assert.equal(SELECTOR_CHALLENGE_OBJECT, "0x860c1e83");
  assert.equal(SELECTOR_CHALLENGE_VOTE, "0xc9d27afe");
  assert.equal(SELECTOR_CHALLENGE_RESOLVE, "0x4f896d4f");
  assert.equal(SELECTOR_CHALLENGE_RELEASE_BOND, "0x34706ecf");
  const reads = {
    milestone: "0xf1135394",
    objection: "0xba6a8406",
    windowFor: "0x28617cd4",
    checkOf: "0xe893f391",
    shareOf: "0x26ca291b",
    milestoneCount: "0x0681ca55",
    team: "0x85f2aef2",
    isTeam: "0x24851914",
    voteWeight: "0x2b0a999d",
    hasVoted: "0x43859632",
    window: "0x461645bf",
    votePeriod: "0xa7813587",
    clawback: "0x2526d960",
    minRejectBps: "0xae468203",
    earliestBlock: "0x20441862",
    bondToken: "0xc28f4392",
    bond: "0x64c9ec6f",
    dao: "0x4162169f",
  };
  for (const [name, selector] of Object.entries(reads)) {
    assert.equal(selectorOf(CHALLENGE_SIGNATURES[name]), selector, name);
  }
});

test("each call's calldata is exactly what cast encodes", () => {
  // cast calldata "submit(uint256,bytes32)" 2 0xabab…
  assert.equal(
    encodeChallengeSubmit(2, EVIDENCE),
    "0x2ecea7880000000000000000000000000000000000000000000000000000000000000002abababababababababababababababababababababababababababababababab",
  );
  // cast calldata "finish(uint256)" 1
  assert.equal(
    encodeChallengeFinish(1),
    "0xd353a1cb0000000000000000000000000000000000000000000000000000000000000001",
  );
  // cast calldata "object(uint256)" 0
  assert.equal(
    encodeChallengeObject(0),
    "0x860c1e830000000000000000000000000000000000000000000000000000000000000000",
  );
  // cast calldata "vote(uint256,bool)" 3 true / false
  assert.equal(
    encodeChallengeVote(3, true),
    "0xc9d27afe00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001",
  );
  assert.equal(
    encodeChallengeVote(3, false),
    "0xc9d27afe00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000",
  );
  // cast calldata "resolve(uint256)" 7
  assert.equal(
    encodeChallengeResolve(7),
    "0x4f896d4f0000000000000000000000000000000000000000000000000000000000000007",
  );
  // cast calldata "releaseBond(uint256)" 4
  assert.equal(
    encodeChallengeReleaseBond(4),
    "0x34706ecf0000000000000000000000000000000000000000000000000000000000000004",
  );
});

test("a call that could never work is refused before a wallet is asked", () => {
  assert.throws(() => encodeChallengeSubmit(-1, EVIDENCE), /does not exist/);
  assert.throws(
    () => encodeChallengeSubmit(MAX_CHALLENGE_MILESTONES, EVIDENCE),
    /does not exist/,
  );
  assert.throws(() => encodeChallengeFinish(1.5), /does not exist/);
  assert.throws(() => encodeChallengeObject(Number.NaN), /does not exist/);
  assert.throws(() => encodeChallengeSubmit(0, "0x12"), /evidence hash/);
  assert.throws(
    () => encodeChallengeSubmit(0, `0x${"0".repeat(64)}`),
    /evidence hash/,
  );
});

// ---- the stages ---------------------------------------------------------------------------------

const objectionOf = (over = {}) => ({
  open: true,
  late: false,
  objector: BACKER,
  snapshot: 10,
  voteEnds: NOW + DAY,
  deposit: WAD,
  eligible: 100n * WAD,
  rejectWeight: 0n,
  acceptWeight: 0n,
  ...over,
});
const stageOf = (m, now = NOW, clawback = 30 * DAY) =>
  challengeStage(
    {
      phase: "none",
      attempts: 0,
      windowEnds: 0,
      unlockedAt: 0,
      lateObjected: false,
      objection: null,
      ...m,
    },
    now,
    clawback,
  );

test("a milestone's stage follows the contract's own comparisons", () => {
  assert.equal(stageOf({}), "not-submitted");
  assert.equal(stageOf({ attempts: 2 }), "rejected");
  // Pending: the window is the line between waiting and ready (the contract finishes at windowEnds).
  assert.equal(stageOf({ phase: "pending", windowEnds: NOW + 1 }), "waiting");
  assert.equal(stageOf({ phase: "pending", windowEnds: NOW }), "ready");
  assert.equal(stageOf({ phase: "pending", windowEnds: NOW - 1 }), "ready");
  // Voting: until the vote ends, then anyone can settle it.
  const voting = { phase: "voting", objection: objectionOf() };
  assert.equal(stageOf(voting), "voting");
  assert.equal(
    stageOf({ ...voting, objection: objectionOf({ voteEnds: NOW }) }),
    "vote-ended",
  );
  // Stood: one more objection may be raised until the clawback period ends, once.
  const stood = { phase: "stood", unlockedAt: NOW - DAY };
  assert.equal(stageOf(stood), "unlocked-open");
  assert.equal(stageOf({ ...stood, lateObjected: true }), "unlocked");
  assert.equal(stageOf({ ...stood, unlockedAt: NOW - 30 * DAY }), "unlocked");
  assert.equal(stageOf(stood, NOW, 0), "unlocked");
  // A late vote.
  const late = objectionOf({ late: true });
  assert.equal(
    stageOf({ ...stood, lateObjected: true, objection: late }),
    "late-voting",
  );
  assert.equal(
    stageOf({
      ...stood,
      lateObjected: true,
      objection: objectionOf({ late: true, voteEnds: NOW - 1 }),
    }),
    "late-vote-ended",
  );
  // A finished objection no longer counts as open.
  assert.equal(
    stageOf({
      ...stood,
      lateObjected: true,
      objection: objectionOf({ late: true, open: false }),
    }),
    "unlocked",
  );
});

test("an objection carries when it beats the other side and reaches the minimum, as the contract decides it", () => {
  const o = (reject, accept, eligible = 120n * WAD) => ({
    rejectWeight: reject * WAD,
    acceptWeight: accept * WAD,
    eligible,
  });
  assert.equal(objectionCarries(o(60n, 30n), 300), true);
  assert.equal(objectionCarries(o(30n, 30n), 300), false, "a tie stands");
  assert.equal(objectionCarries(o(0n, 0n), 300), false);
  // 3% of 120 is 3.6: 3 falls short, 4 clears it, however little is said against it.
  assert.equal(objectionCarries(o(3n, 0n), 300), false);
  assert.equal(objectionCarries(o(4n, 0n), 300), true);
  assert.equal(
    objectionCarries(o(4n, 0n, 124n * WAD), 300),
    true,
    "3.72 needed",
  );
  assert.equal(objectionCarries(o(4n, 0n, 140n * WAD), 300), false);
});

test("a tranche's share reads as a percent", () => {
  assert.equal(challengeTrancheShare(3000), "30%");
  assert.equal(challengeTrancheShare(3333), "33.33%");
});

// ---- reading the lock -----------------------------------------------------------------------------

/** A fake lock that answers by selector. */
function fakeLock({
  milestones,
  count = milestones.length,
  team,
  throws = false,
  locked = {},
}) {
  const asked = [];
  const sel = (sig) => selectorOf(sig);
  return {
    asked,
    async now() {
      return NOW;
    },
    async call(to, data) {
      asked.push({ to, data });
      if (throws) throw new Error("execution reverted");
      assert.equal(to, LOCK);
      const s = data.slice(0, 10);
      const arg = () => Number(BigInt(`0x${data.slice(10, 74)}`));
      if (s === sel("milestoneCount()")) return hex(count);
      if (s === sel("dao()")) return hex(DAO);
      if (s === sel("window()")) return hex(7 * DAY);
      if (s === sel("votePeriod()")) return hex(5 * DAY);
      if (s === sel("clawback()")) return hex(30 * DAY);
      if (s === sel("minRejectBps()")) return hex(300);
      if (s === sel("earliestBlock()")) return hex(105);
      if (s === sel("bondToken()")) return hex(USDC);
      if (s === sel("bond()")) return hex(10n * WAD);
      if (s === sel("deposit()")) return hex(WAD);
      if (s === sel("lockedOf(address)")) {
        const who = `0x${data.slice(34, 74)}`;
        return hex(locked[who] ?? 0);
      }
      if (s === sel("team()")) {
        return hex(32, team.length, ...team.map((t) => BigInt(t)));
      }
      const m = milestones[arg()];
      if (s === sel("checkOf(uint256)")) return hex(m.check);
      if (s === sel("shareOf(uint256)")) return hex(m.bps);
      if (s === sel("windowFor(uint256)")) return hex(m.nextWindow);
      if (s === sel("milestone(uint256)")) {
        return hex(
          m.phase ?? 0,
          m.lateObjected ? 1 : 0,
          m.attempts ?? 0,
          m.submitter ?? 0,
          m.evidence ?? 0,
          m.windowEnds ?? 0,
          m.unlockedAt ?? 0,
          m.bond ?? 0,
        );
      }
      if (s === sel("objection(uint256)")) {
        const o = m.objection ?? {};
        return hex(
          o.open ? 1 : 0,
          o.late ? 1 : 0,
          o.objector ?? 0,
          o.snapshot ?? 0,
          o.voteEnds ?? 0,
          o.deposit ?? 0,
          o.eligible ?? 0,
          o.rejectWeight ?? 0,
          o.acceptWeight ?? 0,
        );
      }
      throw new Error(`unexpected call ${s}`);
    },
  };
}

test("the lock is read whole: its terms, its team and each milestone with the stage it is in", async () => {
  const chain = fakeLock({
    team: [FOUNDER, COFOUNDER],
    locked: { [FOUNDER]: 80n * WAD, [COFOUNDER]: 40n * WAD },
    milestones: [
      {
        check: CHECK_A,
        bps: 3000,
        nextWindow: 14 * DAY,
        phase: 1,
        submitter: FOUNDER,
        evidence: EVIDENCE,
        windowEnds: NOW + 3 * DAY,
        bond: 10n * WAD,
      },
      {
        check: CHECK_B,
        bps: 5000,
        nextWindow: 42 * DAY,
        phase: 2,
        attempts: 1,
        submitter: COFOUNDER,
        evidence: EVIDENCE,
        windowEnds: NOW + DAY,
        bond: 10n * WAD,
        objection: {
          open: true,
          objector: BACKER,
          snapshot: 99,
          voteEnds: NOW + 2 * DAY,
          deposit: WAD,
          eligible: 120n * WAD,
          rejectWeight: 60n * WAD,
          acceptWeight: 30n * WAD,
        },
      },
    ],
  });
  const view = await readChallengeLock(chain, LOCK);
  assert.equal(view.lock, LOCK);
  assert.equal(view.dao, DAO);
  assert.equal(view.now, NOW);
  assert.deepEqual(view.team, [FOUNDER, COFOUNDER]);
  assert.equal(
    view.locked,
    120n * WAD,
    "what each member still has locked, added up",
  );
  assert.deepEqual(view.terms, {
    window: 7 * DAY,
    votePeriod: 5 * DAY,
    clawback: 30 * DAY,
    minRejectBps: 300,
    earliestBlock: 105,
    bondToken: USDC,
    bond: 10n * WAD,
    deposit: WAD,
  });
  const [a, b] = view.milestones;
  assert.equal(a.checkHash, CHECK_A);
  assert.equal(a.bps, 3000);
  assert.equal(a.stage, "waiting");
  assert.equal(a.submitter, FOUNDER);
  assert.equal(a.evidence, EVIDENCE);
  assert.equal(a.objection, null);
  assert.equal(b.stage, "voting");
  assert.equal(b.attempts, 1);
  assert.equal(b.nextWindow, 42 * DAY);
  assert.equal(b.objection.objector, BACKER);
  assert.equal(b.objection.snapshot, 99);
  assert.equal(b.objection.rejectWeight, 60n * WAD);
  assert.equal(b.bond, 10n * WAD);
});

test("a milestone nobody has published reads as untouched, with no submitter or evidence", async () => {
  const chain = fakeLock({
    team: [FOUNDER],
    milestones: [{ check: CHECK_A, bps: 10_000, nextWindow: 21 * DAY }],
  });
  const [m] = (await readChallengeLock(chain, LOCK)).milestones;
  assert.equal(m.stage, "not-submitted");
  assert.equal(m.submitter, null);
  assert.equal(m.evidence, null);
  assert.equal(m.objection, null);
  assert.equal(m.bond, 0n);
});

test("a lock that is not a challenge lock reads as nothing", async () => {
  assert.equal(
    await readChallengeLock(
      fakeLock({ milestones: [], team: [], throws: true }),
      LOCK,
    ),
    null,
  );
  assert.equal(
    await readChallengeLock(fakeLock({ milestones: [], team: [] }), LOCK),
    null,
  );
  await assert.rejects(
    () => readChallengeLock(fakeLock({ milestones: [], team: [] }), "0x12"),
    /lock/,
  );
});

test("a bond in no token reads as none", async () => {
  const chain = fakeLock({
    team: [FOUNDER],
    milestones: [{ check: CHECK_A, bps: 10_000, nextWindow: 7 * DAY }],
  });
  const call = chain.call;
  chain.call = async (to, data) =>
    data.slice(0, 10) === selectorOf("bondToken()") ? hex(0) : call(to, data);
  const view = await readChallengeLock(chain, LOCK);
  assert.equal(view.terms.bondToken, null);
});

test("a voter's weight, whether they have voted, and whether they are on the team", async () => {
  const chain = {
    async call(to, data) {
      assert.equal(to, LOCK);
      const s = data.slice(0, 10);
      if (s === selectorOf("voteWeight(uint256,address)"))
        return hex(60n * WAD);
      if (s === selectorOf("hasVoted(uint256,address)")) return hex(1);
      if (s === selectorOf("isTeam(address)")) return hex(0);
      throw new Error("unexpected");
    },
  };
  assert.deepEqual(await readChallengeVoter(chain, LOCK, 1, BACKER), {
    weight: 60n * WAD,
    voted: true,
    onTeam: false,
  });
  await assert.rejects(
    () => readChallengeVoter(chain, LOCK, 1, "nope"),
    /voter/,
  );
});

test("a DAO's challenge lock is found from its Shares, and a DAO with another kind of lock, or none, has none", async () => {
  const SHARES = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const lock = fakeLock({
    team: [FOUNDER],
    milestones: [{ check: CHECK_A, bps: 10_000, nextWindow: 7 * DAY }],
  });
  const chainFor = (guard, inner = lock) => ({
    now: inner.now,
    async call(to, data) {
      const sel = data.slice(0, 10);
      if (to === DAO && sel === selectorOf("shares()")) return hex(SHARES);
      if (to === SHARES && sel === selectorOf("lockGuard()")) return hex(guard);
      return inner.call(to, data);
    },
  });
  const view = await findChallengeLock(chainFor(LOCK), DAO);
  assert.equal(view.lock, LOCK);
  assert.equal(view.milestones.length, 1);
  // No guard on the Shares: nothing is locked.
  assert.equal(await findChallengeLock(chainFor(0), DAO), null);
  // A guard that is a panel's lock does not answer milestoneCount().
  const panelLock = fakeLock({ milestones: [], team: [], throws: true });
  assert.equal(await findChallengeLock(chainFor(LOCK, panelLock), DAO), null);
  await assert.rejects(() => findChallengeLock(lock, "nope"), /DAO/);
});
