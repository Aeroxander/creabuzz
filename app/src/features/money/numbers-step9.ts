/**
 * The milestone 9 keys of a record (`docs/next-version/RECORD-V2.md` section 14, `COUNCIL-PLAN.md` 5.2): the runner's
 * `kind` and `seats`, the `council` block and the `vote` block. Each is read on its own, apart from the money, the way the
 * step 3 and step 4 keys are: a key that is missing (a record signed before milestone 9) shows nothing new; one that is
 * `null`, malformed or at odds with the record's own numbers reads as `null` for that key only and the rest stands. Never
 * throws, never touches the money, unlocks nothing: it decides what a screen says, and the chain decides what a press
 * does.
 *
 * **This module is loaded only with the screens that show a vote or a Council** (`withStepKeys` is called from the lazy
 * Money tab and the pages that need these keys), and so is the step 4 parser it reads through. The money part of the
 * record parser (`numbers.ts`) keeps the keys as signed and never imports this file, so the first download is not larger.
 *
 * The checks are the server's own (`crates/buzz-relay/src/chain_reader/record_council.rs`), carried here so a record the
 * server signed is still believed only when it adds up. The vote's block has its own reader beside this one
 * (`numbers-step9-vote.ts`: the rule, the ballot, the four times, the floor, the tallies and the derived result); this file
 * reads the runner and the Council and hands the vote to it. A hostile record nulls the key it got wrong; it never crashes
 * and never shows a number.
 */
import {
  address,
  addressOrNull,
  arr,
  bool,
  COUNT_LIMIT,
  fail,
  isObject,
  type Json,
  obj,
  oneOf,
  time,
  timeOrNull,
  whole,
} from "./numbers-strict";
import { readStep4 } from "./numbers-step4";
import { rememberProjectTargets } from "./send-targets";
import { readVote } from "./numbers-step9-vote";
import type {
  CouncilActionKind,
  CouncilNumbers,
  CouncilSeatNumbers,
  CouncilWaitingKind,
  ProjectNumbers,
  RunnerKind,
  VoteNumbers,
} from "./numbers-types";

/** A Council is five seats, and one to five of them must agree. */
const SEATS = 5;
/** The most proposals the record counts before its list says it was cut. */
const WAITING_MAX = 200;

const RUNNER_KINDS = ["single", "pair", "council"] as const;
const ACTION_KINDS = [
  "draw",
  "checkIn",
  "rate",
  "door",
  "plan",
  "accept",
  "reject",
  "cancel",
  "grant",
  "helper",
  "handOver",
  "windDown",
  "other",
] as const;

/** What the keys are checked against: all from the money part of the same record. */
export interface Step9Context {
  asOfTime: number;
  /** The record's time unit in seconds. */
  unit: number;
  /** The backers' Shares (parked ones included). */
  backers: bigint;
  /** `contracts.pause` of the same record, or null (none, or not believed). */
  contractsPause: string | null | undefined;
  /** `runner.address`: a Council the record names must be the runner itself. */
  runnerAddress: string;
  /** `pause.parkedTotal` when that key read, else null: the cast cannot pass it while the vote runs. */
  parkedTotal: bigint | null;
}

/** What the milestone 9 keys of one record say; a field left out here was missing from the record. */
export interface Step9Keys {
  runnerKind?: RunnerKind | null;
  runnerSeats?: number | null;
  council?: CouncilNumbers | null;
  vote?: VoteNumbers | null;
}

function readCouncil(raw: unknown, runnerAddress: string): CouncilNumbers {
  const c = obj(raw, "council");
  const contract = address(c.contract, "council.contract");
  // The vote's Council is the runner itself (the Treasury's runner seat holds the Council contract).
  if (contract !== runnerAddress) fail("council.contract");
  const seatsRaw = arr(c.seats, "council.seats", SEATS);
  if (seatsRaw.length !== SEATS) fail("council.seats");
  const seats = seatsRaw.map((seat) => {
    const s = obj(seat, "council.seats");
    const account = addressOrNull(s.account, "council.seats.account");
    const seatedAt = timeOrNull(s.seatedAt, "council.seats.seatedAt");
    // An open seat has no date; a held one has one.
    if ((account === null) !== (seatedAt === null))
      fail("council.seats.seatedAt");
    return { account, seatedAt };
  }) as [
    CouncilSeatNumbers,
    CouncilSeatNumbers,
    CouncilSeatNumbers,
    CouncilSeatNumbers,
    CouncilSeatNumbers,
  ];
  const held = seats
    .map((seat) => seat.account)
    .filter((account): account is string => account !== null);
  // An account holds one seat; five accounts run it together.
  if (new Set(held).size !== held.length) fail("council.seats.account");
  const needed = positive(c.needed, "council.needed", SEATS);
  const generation = whole(c.generation, "council.generation", 2 ** 32 - 1);
  const nextElection = time(c.nextElection, "council.nextElection");
  const up = arr(c.upSeats, "council.upSeats", 2).map((seat) =>
    whole(seat, "council.upSeats", SEATS - 1),
  );
  if (up.length !== 2) fail("council.upSeats");
  return {
    contract,
    seats,
    needed,
    generation,
    nextElection,
    upSeats: [up[0] as number, up[1] as number],
    waiting: c.waiting === null ? null : readWaiting(c.waiting),
  };
}

function readWaiting(raw: unknown): CouncilNumbers["waiting"] {
  const w = obj(raw, "council.waiting");
  const count = whole(w.count, "council.waiting.count", WAITING_MAX);
  const truncated = bool(w.truncated, "council.waiting.truncated");
  const kinds = arr(w.kinds, "council.waiting.kinds", ACTION_KINDS.length).map(
    (entry) => {
      const e = obj(entry, "council.waiting.kinds");
      const kind = oneOf<CouncilActionKind>(
        e.kind,
        ACTION_KINDS,
        "council.waiting.kinds.kind",
      );
      return {
        kind,
        count: positive(e.count, "council.waiting.kinds.count", COUNT_LIMIT),
      };
    },
  );
  if (new Set(kinds.map((k) => k.kind)).size !== kinds.length)
    fail("council.waiting.kinds.kind");
  const sum = kinds.reduce(
    (total: number, k: CouncilWaitingKind) => total + k.count,
    0,
  );
  // A complete count is the sum of its kinds; a cut one is at most it, and says it was cut.
  if (truncated ? count > sum : count !== sum) fail("council.waiting.count");
  return { count, kinds, truncated };
}

/** A whole number that cannot be zero, inside `max` (a divisor, a length of time). */
function positive(v: unknown, path: string, max: number): number {
  const n = whole(v, path, max);
  if (n === 0) fail(path);
  return n;
}

/** `runner.kind` beside `runner.isPair`: a Pair is still a Pair, and a Council is not one. */
function readRunner(
  raw: unknown,
  isPair: boolean,
): { kind: RunnerKind | null; seats: number | null } {
  const r = obj(raw, "runner");
  const kind =
    r.kind === null
      ? null
      : oneOf<RunnerKind>(r.kind, RUNNER_KINDS, "runner.kind");
  if (kind === "pair" && !isPair) fail("runner.kind");
  if (kind === "council" && isPair) fail("runner.kind");
  const seats = r.seats === null ? null : whole(r.seats, "runner.seats", SEATS);
  // Seats are a Council's number; nothing else has any.
  if (kind !== "council" && seats !== null) fail("runner.seats");
  return { kind, seats };
}

function apart<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * The milestone 9 keys of a record's body: a key that is missing is left out of the result, one that is null or cannot be
 * believed is null. Never throws and never touches the money.
 */
export function readStep9(
  raw: Json,
  ctx: Step9Context,
  isPair: boolean,
): Step9Keys {
  const out: Step9Keys = {};
  if (!isObject(raw)) return out;
  const runner =
    raw.runner === undefined
      ? undefined
      : apart(() => readRunner(raw.runner, isPair));
  if (runner !== undefined) {
    out.runnerKind = runner === null ? null : runner.kind;
    out.runnerSeats = runner === null ? null : runner.seats;
  }
  if (raw.council !== undefined) {
    const council =
      raw.council === null
        ? null
        : apart(() =>
            // A Council is read only when the runner says it is one: nothing else has one.
            out.runnerKind === "council"
              ? readCouncil(raw.council, ctx.runnerAddress)
              : fail("council"),
          );
    out.council = council;
  }
  if (raw.vote !== undefined) {
    out.vote =
      raw.vote === null
        ? null
        : apart(() =>
            readVote(
              raw.vote,
              {
                asOfTime: ctx.asOfTime,
                contractsPause: ctx.contractsPause,
                parkedTotal: ctx.parkedTotal,
              },
              out.council ?? null,
            ),
          );
  }
  // A Council runner's seats count is the seats it holds: the Established rule reads it.
  if (out.runnerKind === "council" && out.council) {
    const held = new Set(
      out.council.seats
        .map((seat) => seat.account)
        .filter((account): account is string => account !== null),
    ).size;
    if (
      out.runnerSeats !== undefined &&
      out.runnerSeats !== null &&
      out.runnerSeats !== held
    )
      out.runnerSeats = null;
  }
  return out;
}

/**
 * The record with its step 4 and milestone 9 keys read: what the Money tab, the Team tab and the two pages that need them
 * show, built from the keys `numbers.ts` kept undecoded. A record signed before those keys carries no such keys and comes
 * back unchanged, so nothing new shows. Called from the lazy screens only, so both parsers stay out of the first download.
 */
export function withStepKeys(numbers: ProjectNumbers): ProjectNumbers {
  const raw = numbers.step;
  if (!raw) return numbers;
  const step4 = readStep4(raw, {
    asOfTime: numbers.asOf.time,
    unit: numbers.unit,
    backers: numbers.shares.backers,
  });
  const step9 = readStep9(
    raw,
    {
      asOfTime: numbers.asOf.time,
      unit: numbers.unit,
      backers: numbers.shares.backers,
      contractsPause: step4.contractsPause,
      runnerAddress: numbers.runner.address,
      parkedTotal:
        step4.pause === undefined ? null : (step4.pause?.parkedTotal ?? null),
    },
    numbers.runner.isPair,
  );
  const withKeys: ProjectNumbers = {
    ...numbers,
    contracts:
      step4.contractsPause === undefined
        ? numbers.contracts
        : { ...numbers.contracts, pause: step4.contractsPause },
    team:
      step4.earlier === undefined
        ? numbers.team
        : { ...numbers.team, earlier: step4.earlier },
    runner: {
      ...numbers.runner,
      ...(step9.runnerKind === undefined ? {} : { kind: step9.runnerKind }),
      ...(step9.runnerSeats === undefined ? {} : { seats: step9.runnerSeats }),
    },
    ...(step4.pause === undefined ? {} : { pause: step4.pause }),
    ...(step4.earlierGrants === undefined
      ? {}
      : { earlierGrants: step4.earlierGrants }),
    ...(step9.council === undefined ? {} : { council: step9.council }),
    ...(step9.vote === undefined ? {} : { vote: step9.vote }),
  };
  // A passkey account may send to every contract the record names, the vote and the Council included.
  rememberProjectTargets(withKeys);
  return withKeys;
}
