/**
 * The team's milestone lock where a milestone unlocks unless holders object, seen from a client
 * (`contracts/src/MilestoneChallenge.sol`, `docs/milestone-challenge.md`).
 *
 * A team member publishes evidence for a milestone and posts a bond; a window opens; with no objection anyone finishes
 * it and the tranche unlocks for the whole team. A holder who is not on the team can object (with a deposit), which
 * opens a vote of non-team holders. This module builds the calls, reads the lock, and says in one place what stage each
 * milestone is in and who can do what next, so the screens never reimplement the contract's timing.
 *
 * Every read is bounded (a lock has at most {@link MAX_CHALLENGE_MILESTONES} milestones and {@link MAX_CHALLENGE_TEAM}
 * team members) and the chain is injected, so `milestoneChallenge.test.mjs` runs the real reader against a fake one.
 */

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import { decodeAddress, encodeCall0 } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** The lock's own caps (`MAX_TRANCHES`, `MAX_TEAM`). */
export const MAX_CHALLENGE_MILESTONES = 8;
export const MAX_CHALLENGE_TEAM = 16;

export const CHALLENGE_SIGNATURES = {
  submit: "submit(uint256,bytes32)",
  finish: "finish(uint256)",
  object: "object(uint256)",
  vote: "vote(uint256,bool)",
  resolve: "resolve(uint256)",
  releaseBond: "releaseBond(uint256)",
  milestone: "milestone(uint256)",
  objection: "objection(uint256)",
  windowFor: "windowFor(uint256)",
  checkOf: "checkOf(uint256)",
  shareOf: "shareOf(uint256)",
  milestoneCount: "milestoneCount()",
  team: "team()",
  isTeam: "isTeam(address)",
  eligibleSupply: "eligibleSupply()",
  voteWeight: "voteWeight(uint256,address)",
  hasVoted: "hasVoted(uint256,address)",
  lockedOf: "lockedOf(address)",
  dao: "dao()",
  window: "window()",
  votePeriod: "votePeriod()",
  clawback: "clawback()",
  minRejectBps: "minRejectBps()",
  earliestBlock: "earliestBlock()",
  bondToken: "bondToken()",
  bond: "bond()",
  deposit: "deposit()",
} as const;

export const SELECTOR_CHALLENGE_SUBMIT = selectorOf(
  CHALLENGE_SIGNATURES.submit,
);
export const SELECTOR_CHALLENGE_FINISH = selectorOf(
  CHALLENGE_SIGNATURES.finish,
);
export const SELECTOR_CHALLENGE_OBJECT = selectorOf(
  CHALLENGE_SIGNATURES.object,
);
export const SELECTOR_CHALLENGE_VOTE = selectorOf(CHALLENGE_SIGNATURES.vote);
export const SELECTOR_CHALLENGE_RESOLVE = selectorOf(
  CHALLENGE_SIGNATURES.resolve,
);
export const SELECTOR_CHALLENGE_RELEASE_BOND = selectorOf(
  CHALLENGE_SIGNATURES.releaseBond,
);

function index(value: number): bigint {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value >= MAX_CHALLENGE_MILESTONES
  ) {
    throw new Error("that milestone does not exist");
  }
  return BigInt(value);
}

/** Publish evidence for milestone `milestone`: `evidence` is the hash of what the team publishes alongside. */
export function encodeChallengeSubmit(
  milestone: number,
  evidence: string,
): string {
  if (!WORD_RE.test(evidence) || /^0x0{64}$/.test(evidence)) {
    throw new Error("the evidence hash must be 0x + 64 hex characters");
  }
  return encodeFunctionData(
    CHALLENGE_SIGNATURES.submit,
    ["uint256", "bytes32"],
    [index(milestone), evidence],
  );
}

/** Finish a milestone nobody objected to, once its window has passed. Anyone may send it. */
export function encodeChallengeFinish(milestone: number): string {
  return encodeFunctionData(
    CHALLENGE_SIGNATURES.finish,
    ["uint256"],
    [index(milestone)],
  );
}

/** Object to a milestone in its window, or (once) to one that unlocked within the clawback period. */
export function encodeChallengeObject(milestone: number): string {
  return encodeFunctionData(
    CHALLENGE_SIGNATURES.object,
    ["uint256"],
    [index(milestone)],
  );
}

/** Vote on an open objection: `reject` backs the objection, otherwise the milestone. */
export function encodeChallengeVote(
  milestone: number,
  reject: boolean,
): string {
  return encodeFunctionData(
    CHALLENGE_SIGNATURES.vote,
    ["uint256", "bool"],
    [index(milestone), reject],
  );
}

/** Settle a vote once it has ended. Anyone may send it. */
export function encodeChallengeResolve(milestone: number): string {
  return encodeFunctionData(
    CHALLENGE_SIGNATURES.resolve,
    ["uint256"],
    [index(milestone)],
  );
}

/** Give the bond back to whoever posted it, once the clawback period is over. Anyone may send it. */
export function encodeChallengeReleaseBond(milestone: number): string {
  return encodeFunctionData(
    CHALLENGE_SIGNATURES.releaseBond,
    ["uint256"],
    [index(milestone)],
  );
}

// ---------------------------------------------------------------------------
// What the lock says
// ---------------------------------------------------------------------------

export interface ChallengeTerms {
  window: number;
  votePeriod: number;
  clawback: number;
  minRejectBps: number;
  earliestBlock: number;
  bondToken: string | null;
  bond: bigint;
  deposit: bigint;
}

export type ChallengePhase = "none" | "pending" | "voting" | "stood";
const PHASES: ChallengePhase[] = ["none", "pending", "voting", "stood"];

export interface ChallengeObjection {
  open: boolean;
  /** Raised after an unlock (within the clawback period), not before. */
  late: boolean;
  objector: string;
  /** The block whose votes count. */
  snapshot: number;
  voteEnds: number;
  deposit: bigint;
  /** What could vote when it was raised. */
  eligible: bigint;
  rejectWeight: bigint;
  acceptWeight: bigint;
}

/**
 * Where a milestone is, in the words a screen uses.
 *  - `not-submitted`: nothing published yet.
 *  - `rejected`: the last attempt was upheld against; the next window is longer.
 *  - `waiting`: published; objections welcome until the window ends.
 *  - `ready`: the window passed with no objection; anyone can finish it.
 *  - `voting`: an objection is open and holders are voting.
 *  - `vote-ended`: the vote is over; anyone can settle it.
 *  - `unlocked`: it stood, and the clawback period is over.
 *  - `unlocked-open`: it stood and one more objection may still be raised.
 *  - `late-voting` / `late-vote-ended`: a vote after an unlock, which can burn what is still locked.
 */
export type ChallengeStage =
  | "not-submitted"
  | "rejected"
  | "waiting"
  | "ready"
  | "voting"
  | "vote-ended"
  | "unlocked"
  | "unlocked-open"
  | "late-voting"
  | "late-vote-ended";

export interface ChallengeMilestone {
  index: number;
  /** keccak256 of the words this milestone is judged by. */
  checkHash: string;
  /** The part of every team member's Shares it unlocks, in basis points. */
  bps: number;
  /** How long the next submission would wait, after size and retry scaling. */
  nextWindow: number;
  phase: ChallengePhase;
  lateObjected: boolean;
  /** How many attempts were upheld against. */
  attempts: number;
  submitter: string | null;
  evidence: string | null;
  windowEnds: number;
  unlockedAt: number;
  /** The bond still held for this milestone. */
  bond: bigint;
  objection: ChallengeObjection | null;
  stage: ChallengeStage;
}

export interface ChallengeLockView {
  lock: string;
  dao: string;
  terms: ChallengeTerms;
  team: string[];
  /** What the whole team still has locked, in Share base units (the lock's own answer for each member, added up). */
  locked: bigint;
  milestones: ChallengeMilestone[];
  /** The chain's clock when this was read. */
  now: number;
}

/** The stage of a milestone at `now`. The contract's own comparisons, in one place. */
export function challengeStage(
  m: Pick<
    ChallengeMilestone,
    | "phase"
    | "attempts"
    | "windowEnds"
    | "unlockedAt"
    | "lateObjected"
    | "objection"
  >,
  now: number,
  clawback: number,
): ChallengeStage {
  const open = m.objection?.open ? m.objection : null;
  switch (m.phase) {
    case "none":
      return m.attempts > 0 ? "rejected" : "not-submitted";
    case "pending":
      return now < m.windowEnds ? "waiting" : "ready";
    case "voting":
      return open && now < open.voteEnds ? "voting" : "vote-ended";
    case "stood":
      if (open) return now < open.voteEnds ? "late-voting" : "late-vote-ended";
      return !m.lateObjected && now < m.unlockedAt + clawback
        ? "unlocked-open"
        : "unlocked";
  }
}

const body = (hex: string): string => hex.replace(/^0x/, "");
const word = (hex: string, i: number): bigint =>
  BigInt(`0x${body(hex).slice(i * 64, (i + 1) * 64) || "0"}`);
const addr = (hex: string, i: number): string =>
  `0x${body(hex).slice(i * 64 + 24, (i + 1) * 64)}`.toLowerCase();
const bytes32 = (hex: string, i: number): string =>
  `0x${body(hex)
    .slice(i * 64, (i + 1) * 64)
    .padStart(64, "0")}`;

function assertAddress(value: string, what: string): void {
  if (!ADDRESS_RE.test(value)) throw new Error(`${what} is not an address`);
}

const call1 = (signature: string, value: number) =>
  encodeFunctionData(signature, ["uint256"], [BigInt(value)]);

/** `address[]` returned by `team()`: offset, length, then the addresses. */
function decodeAddressArray(hex: string, max: number): string[] {
  const offset = Number(word(hex, 0)) / 32;
  const length = Math.min(Number(word(hex, offset)), max);
  return Array.from({ length }, (_, i) => addr(hex, offset + 1 + i));
}

/**
 * The challenge lock, or null when `lock` does not answer like one (a panel lock, an older DAO, or nothing). Everything
 * is read from the chain: only the lock's own answers decide what can happen.
 */
export async function readChallengeLock(
  chain: Pick<WorkChain, "call" | "now">,
  lock: string,
): Promise<ChallengeLockView | null> {
  assertAddress(lock, "the lock");
  let countHex: string;
  try {
    countHex = await chain.call(
      lock,
      encodeCall0(CHALLENGE_SIGNATURES.milestoneCount),
    );
  } catch {
    return null;
  }
  const count = Math.min(Number(word(countHex, 0)), MAX_CHALLENGE_MILESTONES);
  if (count === 0) return null;
  const read = (signature: string) =>
    chain.call(lock, encodeCall0(signature)).then((hex) => hex);
  const [
    dao,
    window,
    votePeriod,
    clawback,
    minRejectBps,
    earliestBlock,
    bondToken,
    bond,
    deposit,
    teamHex,
    now,
  ] = await Promise.all([
    read(CHALLENGE_SIGNATURES.dao),
    read(CHALLENGE_SIGNATURES.window),
    read(CHALLENGE_SIGNATURES.votePeriod),
    read(CHALLENGE_SIGNATURES.clawback),
    read(CHALLENGE_SIGNATURES.minRejectBps),
    read(CHALLENGE_SIGNATURES.earliestBlock),
    read(CHALLENGE_SIGNATURES.bondToken),
    read(CHALLENGE_SIGNATURES.bond),
    read(CHALLENGE_SIGNATURES.deposit),
    read(CHALLENGE_SIGNATURES.team),
    chain.now(),
  ]);
  const token = decodeAddress(bondToken);
  const terms: ChallengeTerms = {
    window: Number(word(window, 0)),
    votePeriod: Number(word(votePeriod, 0)),
    clawback: Number(word(clawback, 0)),
    minRejectBps: Number(word(minRejectBps, 0)),
    earliestBlock: Number(word(earliestBlock, 0)),
    bondToken: token === ZERO_ADDRESS ? null : token,
    bond: word(bond, 0),
    deposit: word(deposit, 0),
  };
  const milestones = await Promise.all(
    Array.from({ length: count }, async (_, i): Promise<ChallengeMilestone> => {
      const [check, share, next, state, objection] = await Promise.all([
        chain.call(lock, call1(CHALLENGE_SIGNATURES.checkOf, i)),
        chain.call(lock, call1(CHALLENGE_SIGNATURES.shareOf, i)),
        chain.call(lock, call1(CHALLENGE_SIGNATURES.windowFor, i)),
        chain.call(lock, call1(CHALLENGE_SIGNATURES.milestone, i)),
        chain.call(lock, call1(CHALLENGE_SIGNATURES.objection, i)),
      ]);
      const phase = PHASES[Number(word(state, 0))] ?? "none";
      const submitter = addr(state, 3);
      const evidence = bytes32(state, 4);
      // An objection exists once someone has raised one: its objector is never the zero address.
      const obj: ChallengeObjection | null =
        addr(objection, 2) !== ZERO_ADDRESS
          ? {
              open: word(objection, 0) !== 0n,
              late: word(objection, 1) !== 0n,
              objector: addr(objection, 2),
              snapshot: Number(word(objection, 3)),
              voteEnds: Number(word(objection, 4)),
              deposit: word(objection, 5),
              eligible: word(objection, 6),
              rejectWeight: word(objection, 7),
              acceptWeight: word(objection, 8),
            }
          : null;
      const partial = {
        phase,
        lateObjected: word(state, 1) !== 0n,
        attempts: Number(word(state, 2)),
        windowEnds: Number(word(state, 5)),
        unlockedAt: Number(word(state, 6)),
        objection: obj,
      };
      return {
        index: i,
        checkHash: bytes32(check, 0),
        bps: Number(word(share, 0)),
        nextWindow: Number(word(next, 0)),
        ...partial,
        submitter: submitter === ZERO_ADDRESS ? null : submitter,
        evidence: /^0x0{64}$/.test(evidence) ? null : evidence,
        bond: word(state, 7),
        stage: challengeStage(partial, now, terms.clawback),
      };
    }),
  );
  const team = decodeAddressArray(teamHex, MAX_CHALLENGE_TEAM);
  const lockedEach = await Promise.all(
    team.map((member) =>
      chain.call(
        lock,
        encodeFunctionData(
          CHALLENGE_SIGNATURES.lockedOf,
          ["address"],
          [member],
        ),
      ),
    ),
  );
  return {
    lock: lock.toLowerCase(),
    dao: decodeAddress(dao),
    terms,
    team,
    locked: lockedEach.reduce((sum, hex) => sum + word(hex, 0), 0n),
    milestones,
    now,
  };
}

/**
 * The challenge lock a DAO's Shares point at, or null when the DAO has no lock or its lock is not a challenge lock (a
 * panel's lock does not answer `milestoneCount()`). The lock is found from the Shares contract, not from a record: only
 * the Shares contract's own answer decides what can move.
 */
export async function findChallengeLock(
  chain: Pick<WorkChain, "call" | "now">,
  dao: string,
): Promise<ChallengeLockView | null> {
  assertAddress(dao, "the DAO");
  const shares = decodeAddress(await chain.call(dao, encodeCall0("shares()")));
  if (shares === ZERO_ADDRESS) return null;
  const guard = decodeAddress(
    await chain.call(shares, encodeCall0("lockGuard()")),
  );
  if (guard === ZERO_ADDRESS) return null;
  return readChallengeLock(chain, guard);
}

/** What `who`'s vote would count for on a milestone, and whether they have already voted (the objector has). */
export async function readChallengeVoter(
  chain: Pick<WorkChain, "call">,
  lock: string,
  milestone: number,
  who: string,
): Promise<{ weight: bigint; voted: boolean; onTeam: boolean }> {
  assertAddress(lock, "the lock");
  assertAddress(who, "the voter");
  const args = [BigInt(milestone), who];
  const [weight, voted, team] = await Promise.all([
    chain.call(
      lock,
      encodeFunctionData(
        CHALLENGE_SIGNATURES.voteWeight,
        ["uint256", "address"],
        args,
      ),
    ),
    chain.call(
      lock,
      encodeFunctionData(
        CHALLENGE_SIGNATURES.hasVoted,
        ["uint256", "address"],
        args,
      ),
    ),
    chain.call(
      lock,
      encodeFunctionData(CHALLENGE_SIGNATURES.isTeam, ["address"], [who]),
    ),
  ]);
  return {
    weight: word(weight, 0),
    voted: word(voted, 0) !== 0n,
    onTeam: word(team, 0) !== 0n,
  };
}

/** Whether the rejecting weight carries an open objection as things stand: more than the other side, and the minimum. */
export function objectionCarries(
  objection: Pick<
    ChallengeObjection,
    "rejectWeight" | "acceptWeight" | "eligible"
  >,
  minRejectBps: number,
): boolean {
  return (
    objection.rejectWeight > objection.acceptWeight &&
    objection.rejectWeight * 10_000n >=
      objection.eligible * BigInt(minRejectBps)
  );
}

/** What each team member's tranche for this milestone holds back, for the screen. */
export function challengeTrancheShare(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
}
