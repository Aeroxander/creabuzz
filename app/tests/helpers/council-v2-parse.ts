// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
/**
 * A milestone 9 record for the tests, built from the one example the server and the app both test against (never retyped):
 * the ordinary example with a Council runner and one ballot added. Every number here is the contract's own (a 7-day unit,
 * a one-day stand window, a three-day vote, the 16.5-day wait); a test that changes one changes the sentence, which is the
 * point. `councilPlain()` is the base example's record untouched, for the "nothing new" rows of the plan's 6.6 table.
 */
import {
  event,
  parsedExample,
  raw as baseRaw,
  SERVER,
} from "./numbers-v2-parse";
import {
  parseNumbers,
  type ProjectNumbers,
} from "../../src/features/money/numbers";
import { withStepKeys } from "../../src/features/money/numbers-step9";

export { SERVER };
export const NOW = 1_803_787_880;
export const DAY = 86_400;
export const WAIT = 1_425_600; // 16.5 days, the Treasury's longest task notice
export const VOTE = "0x0165878a594ca255338adfa4d48449f69242eb8f";
export const COUNCIL = "0xa513e6e4b8a2f1c6c1f0e0e5b9b0a5b8de9c2b41";
export const TREASURY = "0x75537828f2ce51be7289709686a69cbfdbb714f1";
export const HASH = `0x${"ab".repeat(32)}`;
export const OTHER_HASH = `0x${"cd".repeat(32)}`;

export const ACCOUNTS = [
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
];
/** A second five, for a list that wins. */
export const LIST = [
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  "0xbcd4042de499d14e55001ccbb24a551f3b954096",
];

const E18 = 1_000_000_000_000_000_000n;
const SUPPLY = 1_000_000n * E18;
const FLOOR = (SUPPLY + 2n) / 3n; // supply over LINE_DIVISOR (3), rounded up
const shares = (n: bigint) => (n * E18).toString();

/** One option of the test ballot, in the record's own shape. */
export interface TestOption {
  index: number;
  kind: "keep" | "list" | "person";
  members: string[];
  proposer: string | null;
  recordHash: string | null;
  tally: string;
}

/** A ballot, by its phase: each case carries the times, the phase, the result and the options the server would sign. */
export type BallotCase =
  | "voting"
  | "standing"
  | "seats"
  | "seats-standing"
  | "moved"
  | "waiting"
  | "counting"
  | "carried-out"
  | "lapsed"
  | "kept"
  | "short"
  | "seated"
  | "unchanged";

function keep(tally: bigint): TestOption {
  return {
    index: 0,
    kind: "keep",
    members: [],
    proposer: null,
    recordHash: null,
    tally: shares(tally),
  };
}

function list(index: number, tally: bigint): TestOption {
  return {
    index,
    kind: "list",
    members: LIST,
    proposer: ACCOUNTS[0] as string,
    recordHash: HASH,
    tally: shares(tally),
  };
}

function person(index: number, who: string, tally: bigint): TestOption {
  return {
    index,
    kind: "person",
    members: [who],
    proposer: who,
    recordHash: HASH,
    tally: shares(tally),
  };
}

/** The four times, in order, from the ballot's first second: a 4-day ballot and the 16.5-day wait. */
export function timesFrom(openedAt: number) {
  const standEnd = openedAt + DAY;
  const voteEnd = standEnd + 3 * DAY;
  return { openedAt, standEnd, voteEnd, effectiveAt: voteEnd + WAIT };
}

/** The ballot a case shows, with every field the record carries. */
export function ballotOf(testCase: BallotCase): any {
  const base = (over: any) => ({
    id: 3,
    kind: "replace",
    ...timesFrom(NOW - 2 * DAY),
    supply: SUPPLY.toString(),
    floor: FLOOR.toString(),
    cast: shares(400_000n),
    options: [keep(300_000n), list(1, 100_000n)],
    result: null,
    carriedOutAt: null,
    phase: "voting",
    ...over,
  });
  switch (testCase) {
    case "standing":
      return base({ ...timesFrom(NOW - DAY / 2), phase: "standing" });
    case "seats":
      return base({
        kind: "seats",
        options: [
          keep(50_000n),
          person(1, ACCOUNTS[0] as string, 200_000n),
          person(2, ACCOUNTS[1] as string, 150_000n),
        ],
      });
    case "seats-standing":
      return base({
        ...timesFrom(NOW - DAY / 2),
        kind: "seats",
        phase: "standing",
        options: [
          keep(50_000n),
          person(1, ACCOUNTS[0] as string, 200_000n),
          person(2, ACCOUNTS[1] as string, 150_000n),
        ],
      });
    case "voting":
      return base({});
    case "moved":
      return base({
        ...timesFrom(NOW - 10 * DAY),
        phase: "waiting",
        options: [keep(100_000n), list(1, 300_000n)],
        result: { outcome: "moved", winners: [1], recorded: false },
      });
    case "waiting":
      return base({
        ...timesFrom(NOW - 8 * DAY),
        phase: "waiting",
        options: [keep(100_000n), list(1, 300_000n)],
        result: { outcome: "moved", winners: [1], recorded: true },
      });
    case "counting":
      return base({
        ...timesFrom(NOW - 30 * DAY),
        phase: "counting",
        options: [keep(100_000n), list(1, 300_000n)],
        result: { outcome: "moved", winners: [1], recorded: true },
      });
    case "carried-out":
      return base({
        ...timesFrom(NOW - 30 * DAY),
        phase: "carried-out",
        options: [keep(100_000n), list(1, 300_000n)],
        result: { outcome: "moved", winners: [1], recorded: true },
        carriedOutAt: timesFrom(NOW - 30 * DAY).effectiveAt,
      });
    case "lapsed":
      return base({
        ...timesFrom(NOW - 30 * DAY),
        phase: "lapsed",
        options: [keep(100_000n), list(1, 300_000n)],
        result: { outcome: "moved", winners: [1], recorded: true },
      });
    case "kept":
      return base({
        ...timesFrom(NOW - 10 * DAY),
        phase: "ended",
        options: [keep(350_000n), list(1, 50_000n)],
        result: { outcome: "kept", winners: [], recorded: false },
      });
    case "short":
      return base({
        ...timesFrom(NOW - 10 * DAY),
        phase: "ended",
        cast: shares(100_000n),
        options: [keep(60_000n), list(1, 40_000n)],
        result: { outcome: "short", winners: [], recorded: true },
      });
    case "seated":
      return base({
        ...timesFrom(NOW - 10 * DAY),
        kind: "seats",
        phase: "waiting",
        options: [
          keep(50_000n),
          person(1, ACCOUNTS[0] as string, 200_000n),
          person(2, ACCOUNTS[1] as string, 150_000n),
        ],
        result: { outcome: "seated", winners: [1, 2], recorded: false },
      });
    case "unchanged":
      return base({
        ...timesFrom(NOW - 10 * DAY),
        kind: "seats",
        phase: "ended",
        options: [keep(400_000n), person(1, ACCOUNTS[0] as string, 0n)],
        result: { outcome: "unchanged", winners: [], recorded: true },
      });
  }
}

/** The Council the record's runner is: five seats, three must agree, the next election 20 days out. */
export function councilOf(over: any = {}): any {
  return {
    contract: COUNCIL,
    seats: ACCOUNTS.map((account, i) => ({
      account,
      seatedAt: NOW - (i + 1) * DAY,
    })),
    needed: 3,
    generation: 1,
    nextElection: NOW + 20 * DAY,
    upSeats: [0, 1],
    waiting: {
      count: 1,
      kinds: [{ kind: "draw", count: 1 }],
      truncated: false,
    },
    ...over,
  };
}

/** The vote contract's every number, read from its constants: nothing here is typed by a sentence. */
export function ruleOf(over: any = {}): any {
  return {
    standSecs: DAY,
    voteSecs: 3 * DAY,
    waitSecs: WAIT,
    floorDivisor: 3,
    openDivisor: 20,
    standDivisor: 1000,
    cooldownSecs: 4 * 7 * DAY,
    seatsEverySecs: 26 * 7 * DAY,
    proposalTtlSecs: 2 * 7 * DAY,
    needed: 3,
    seats: 5,
    maxLists: 4,
    maxPeople: 12,
    minVote: E18.toString(),
    ...over,
  };
}

/**
 * A milestone 9 record: the ordinary example with a Council runner, a vote contract (the pause's own address) and one
 * ballot. `change` edits the loose JSON before it is signed, the way a hostile one arrives.
 */
export function councilRaw(
  testCase: BallotCase = "voting",
  change: (r: any) => void = () => {},
): any {
  const r = baseRaw() as any;
  r.contracts.pause = VOTE;
  r.runner = {
    address: COUNCIL,
    isPair: false,
    signers: null,
    kind: "council",
    seats: 5,
  };
  r.council = councilOf();
  r.vote = {
    contract: VOTE,
    rule: ruleOf(),
    open: ballotOf(testCase),
    next: {
      seatsAt: r.council.nextElection,
      replaceFrom: NOW,
      openFloor: shares(50_000n),
    },
  };
  change(r);
  return r;
}

const parse = (content: any): ProjectNumbers => {
  const key = String(content.key).toLowerCase();
  const n = parseNumbers(event(content, { tags: [["d", key]] }), SERVER);
  if (!n || n.removed) throw new Error("the record did not parse");
  return withStepKeys(n);
};

/** The Parsed record of a case, with the milestone 9 keys read. */
export const councilRecord = (
  testCase: BallotCase = "voting",
  change?: (r: any) => void,
) => parse(councilRaw(testCase, change));

/** The ordinary example's record untouched: no Council, no vote, no runner kind. */
export const councilPlain = (): ProjectNumbers => parsedExample();
