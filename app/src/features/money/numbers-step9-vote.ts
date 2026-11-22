/**
 * The `vote` block of a milestone 9 record (`docs/next-version/RECORD-V2.md` section 14, `COUNCIL-PLAN.md` 5.2): the
 * rule every sentence takes its numbers from, the newest ballot and what the next ones allow. Read on its own, apart from
 * the money and from the other keys: anything that does not add up nulls the vote and nothing else.
 *
 * The checks are the server's own (`crates/buzz-relay/src/chain_reader/record_council.rs`), carried here so a record is
 * believed only when it adds up: the tallies are the cast total, the four times are in order and built from the rule's
 * numbers, the floor is the supply over its divisor rounded up, the cast never passes the Shares at the snapshot and,
 * while the vote runs, never passes what is parked. The result at `voteEnd` is derived exactly as the contract does, so the
 * card and the alerts show it with nobody pressing `finish`.
 */
import {
  address,
  addressOrNull,
  amount,
  arr,
  bool,
  bytes32,
  COUNT_LIMIT,
  fail,
  obj,
  oneOf,
  time,
  timeOrNull,
  whole,
} from "./numbers-strict";
import type {
  CouncilNumbers,
  VoteKind,
  VoteNextNumbers,
  VoteNumbers,
  VoteOpenNumbers,
  VoteOptionKind,
  VoteOptionNumbers,
  VoteOutcome,
  VotePhase,
  VoteResultNumbers,
  VoteRule,
} from "./numbers-types";

/** A ballot offers "keep" and at most this many choices (the contract's cap on the option list). */
const OPTIONS_MAX = 13;
/** A Council is five seats, and one to five of them must agree. */
const SEATS = 5;
const VOTE_KINDS = ["seats", "replace"] as const;
const PHASES = [
  "standing",
  "voting",
  "counting",
  "waiting",
  "carried-out",
  "ended",
  "lapsed",
] as const;
const OUTCOMES = ["short", "kept", "moved", "seated", "unchanged"] as const;
const OPTION_KINDS = ["keep", "list", "person"] as const;

/** What the vote block is checked against: the record's own time and pause keys. */
export interface VoteContext {
  asOfTime: number;
  /** `contracts.pause` of the same record, or null (none, or not believed). */
  contractsPause: string | null | undefined;
  /** `pause.parkedTotal` when that key read, else null: the cast cannot pass it while the vote runs. */
  parkedTotal: bigint | null;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** A whole number that cannot be zero, inside `max` (a divisor, a length of time). */
function positive(v: unknown, path: string, max: number): number {
  const n = whole(v, path, max);
  if (n === 0) fail(path);
  return n;
}

function readRule(raw: unknown): VoteRule {
  const r = obj(raw, "vote.rule");
  const divisor = (v: unknown, path: string) => positive(v, path, 1_000_000);
  const since = (v: unknown, path: string) => positive(v, path, 2 ** 40);
  const rule: VoteRule = {
    standSecs: since(r.standSecs, "vote.rule.standSecs"),
    voteSecs: since(r.voteSecs, "vote.rule.voteSecs"),
    waitSecs: since(r.waitSecs, "vote.rule.waitSecs"),
    floorDivisor: divisor(r.floorDivisor, "vote.rule.floorDivisor"),
    openDivisor: divisor(r.openDivisor, "vote.rule.openDivisor"),
    standDivisor: divisor(r.standDivisor, "vote.rule.standDivisor"),
    cooldownSecs: whole(r.cooldownSecs, "vote.rule.cooldownSecs", 2 ** 40),
    seatsEverySecs: since(r.seatsEverySecs, "vote.rule.seatsEverySecs"),
    proposalTtlSecs: since(r.proposalTtlSecs, "vote.rule.proposalTtlSecs"),
    needed: positive(r.needed, "vote.rule.needed", SEATS),
    seats: positive(r.seats, "vote.rule.seats", SEATS),
    maxLists: positive(r.maxLists, "vote.rule.maxLists", OPTIONS_MAX),
    maxPeople: positive(r.maxPeople, "vote.rule.maxPeople", OPTIONS_MAX),
    minVote: amount(r.minVote, "vote.rule.minVote"),
  };
  if (rule.seats !== SEATS) fail("vote.rule.seats");
  if (rule.minVote === 0n) fail("vote.rule.minVote");
  return rule;
}

/** One choice of the open ballot, checked against its place, its ballot's kind and the rule. */
function readOption(
  raw: unknown,
  i: number,
  kind: VoteKind,
): VoteOptionNumbers {
  const o = obj(raw, "vote.open.options");
  if (whole(o.index, "vote.open.options.index", OPTIONS_MAX) !== i)
    fail("vote.open.options.index");
  const optionKind = oneOf<VoteOptionKind>(
    o.kind,
    OPTION_KINDS,
    "vote.open.options.kind",
  );
  if (i === 0 ? optionKind !== "keep" : optionKind === "keep")
    fail("vote.open.options.kind");
  if (optionKind === "list" && kind !== "replace")
    fail("vote.open.options.kind");
  if (optionKind === "person" && kind !== "seats")
    fail("vote.open.options.kind");
  const members = arr(o.members, "vote.open.options.members", SEATS).map((m) =>
    address(m, "vote.open.options.members"),
  );
  if (optionKind === "keep" && members.length !== 0)
    fail("vote.open.options.members");
  if (optionKind === "person" && members.length !== 1)
    fail("vote.open.options.members");
  if (optionKind === "list" && members.length !== SEATS)
    fail("vote.open.options.members");
  if (new Set(members).size !== members.length)
    fail("vote.open.options.members");
  const proposer = addressOrNull(o.proposer, "vote.open.options.proposer");
  const recordHash = bytes32OrNull(
    o.recordHash,
    "vote.open.options.recordHash",
  );
  // "keep" names nobody and has no text; a person or a list names its proposer and its signed text.
  if (optionKind === "keep") {
    if (proposer !== null || recordHash !== null)
      fail("vote.open.options.proposer");
  } else if (proposer === null || recordHash === null) {
    fail("vote.open.options.proposer");
  }
  return {
    index: i,
    kind: optionKind,
    members,
    proposer,
    recordHash,
    tally: amount(o.tally, "vote.open.options.tally"),
  };
}

function bytes32OrNull(v: unknown, path: string): string | null {
  return v === null ? null : bytes32(v, path);
}

/**
 * The result the frozen tallies give, exactly as the contract's `_compute` and the server's `derive_result` do
 * (COUNCIL-PLAN.md 2.6): a list needs more than half of everything cast; a person needs more than "keep" and one whole
 * Share, and a tie for the last seat leaves that seat as it is.
 */
function deriveResult(
  kind: VoteKind,
  options: readonly VoteOptionNumbers[],
  cast: bigint,
  floor: bigint,
  minVote: bigint,
): { outcome: VoteOutcome; winners: number[] } {
  const tally = (i: number) => options[i]?.tally ?? 0n;
  if (cast < floor) return { outcome: "short", winners: [] };
  if (kind === "replace") {
    for (let i = 1; i < options.length; i += 1)
      if (tally(i) * 2n > cast) return { outcome: "moved", winners: [i] };
    return { outcome: "kept", winners: [] };
  }
  const keep = tally(0);
  // The contract's own ranking: `best` is the highest tally above "keep", `second` the highest after it.
  let best = 0n;
  let bestAt = 0;
  let second = 0n;
  let secondAt = 0;
  for (let i = 1; i < options.length; i += 1) {
    const t = tally(i);
    if (t < minVote || t <= keep) continue;
    if (bestAt === 0 || t > best) {
      second = best;
      secondAt = bestAt;
      best = t;
      bestAt = i;
    } else if (secondAt === 0 || t > second) {
      second = t;
      secondAt = i;
    }
  }
  if (bestAt === 0) return { outcome: "unchanged", winners: [] };
  if (secondAt !== 0 && second < best)
    return { outcome: "seated", winners: [bestAt, secondAt] };
  return { outcome: "seated", winners: [bestAt] };
}

/** The result the record carries, checked against the tallies it was worked out from. */
function readResult(
  raw: unknown,
  derived: { outcome: VoteOutcome; winners: number[] },
): VoteResultNumbers {
  const r = obj(raw, "vote.open.result");
  const outcome = oneOf<VoteOutcome>(
    r.outcome,
    OUTCOMES,
    "vote.open.result.outcome",
  );
  if (outcome !== derived.outcome) fail("vote.open.result.outcome");
  const winners = arr(r.winners, "vote.open.result.winners", 2).map((w) =>
    whole(w, "vote.open.result.winners", OPTIONS_MAX - 1),
  );
  if (
    winners.length !== derived.winners.length ||
    winners.some((w, i) => w !== derived.winners[i])
  )
    fail("vote.open.result.winners");
  return {
    outcome,
    winners: derived.winners,
    recorded: bool(r.recorded, "vote.open.result.recorded"),
  };
}

/**
 * Where the ballot stands at the record's own time. The record's `phase` is checked against everything the app can work
 * out on its own: a `carried-out` or `lapsed` flag it could not see is taken as the server says, and nothing else is.
 */
function readPhase(
  raw: unknown,
  open: {
    carriedOutAt: number | null;
    standEnd: number;
    voteEnd: number;
    effectiveAt: number;
    result: VoteResultNumbers | null;
  },
  asOfTime: number,
): VotePhase {
  const phase = oneOf<VotePhase>(raw, PHASES, "vote.open.phase");
  const won =
    open.result?.outcome === "moved" || open.result?.outcome === "seated";
  let expected: VotePhase | null;
  if (open.carriedOutAt !== null) expected = "carried-out";
  else if (asOfTime < open.standEnd) expected = "standing";
  else if (asOfTime < open.voteEnd) expected = "voting";
  else if (!won) expected = "ended";
  else if (asOfTime < open.effectiveAt) expected = "waiting";
  else expected = null; // due and being carried out: "counting", or "lapsed" once its time is up
  if (phase === "carried-out" && open.carriedOutAt === null)
    fail("vote.open.phase");
  if (phase === "lapsed" && (won === false || asOfTime < open.effectiveAt))
    fail("vote.open.phase");
  if (
    expected !== null
      ? phase !== expected
      : !["counting", "lapsed"].includes(phase)
  )
    fail("vote.open.phase");
  return phase;
}

function readOpen(
  raw: unknown,
  rule: VoteRule,
  ctx: VoteContext,
): VoteOpenNumbers {
  const o = obj(raw, "vote.open");
  const kind = oneOf<VoteKind>(o.kind, VOTE_KINDS, "vote.open.kind");
  const openedAt = time(o.openedAt, "vote.open.openedAt");
  const standEnd = time(o.standEnd, "vote.open.standEnd");
  const voteEnd = time(o.voteEnd, "vote.open.voteEnd");
  const effectiveAt = time(o.effectiveAt, "vote.open.effectiveAt");
  // The four times are in order, and each gap is the rule's own number: no sentence types one.
  if (!(openedAt < standEnd && standEnd < voteEnd && voteEnd < effectiveAt))
    fail("vote.open.openedAt");
  if (standEnd - openedAt !== rule.standSecs) fail("vote.open.standEnd");
  if (voteEnd - standEnd !== rule.voteSecs) fail("vote.open.voteEnd");
  if (effectiveAt - voteEnd !== rule.waitSecs) fail("vote.open.effectiveAt");
  const supply = amount(o.supply, "vote.open.supply");
  const floor = amount(o.floor, "vote.open.floor");
  if (floor !== ceilDiv(supply, BigInt(rule.floorDivisor)))
    fail("vote.open.floor");
  if (floor > supply) fail("vote.open.floor");
  const cast = amount(o.cast, "vote.open.cast");
  if (cast > supply) fail("vote.open.cast");
  // The tallies freeze at `voteEnd`; until then the cast cannot pass what is parked (a Share that leaves stops counting).
  if (
    ctx.asOfTime < voteEnd &&
    ctx.parkedTotal !== null &&
    cast > ctx.parkedTotal
  )
    fail("vote.open.cast");
  const list = arr(o.options, "vote.open.options", OPTIONS_MAX);
  if (list.length === 0) fail("vote.open.options");
  const options = list.map((option, i) => readOption(option, i, kind));
  if (kind === "replace" && options.length - 1 > rule.maxLists)
    fail("vote.open.options");
  if (kind === "seats" && options.length - 1 > rule.maxPeople)
    fail("vote.open.options");
  const sum = options.reduce((total, option) => total + option.tally, 0n);
  if (sum !== cast) fail("vote.open.options");
  const derived = deriveResult(kind, options, cast, floor, rule.minVote);
  // The tallies are not final before `voteEnd`, so a result before it is not believed; from `voteEnd` on it must be the
  // one the tallies give (the server derives it, so the card and the alerts show it with nobody pressing `finish`).
  const result =
    ctx.asOfTime < voteEnd
      ? absentResult(o.result)
      : readResult(o.result, derived);
  const carriedOutAt = timeOrNull(o.carriedOutAt, "vote.open.carriedOutAt");
  if (carriedOutAt !== null && carriedOutAt < effectiveAt)
    fail("vote.open.carriedOutAt");
  const phase = readPhase(
    o.phase,
    {
      carriedOutAt,
      standEnd,
      voteEnd,
      effectiveAt,
      result,
    },
    ctx.asOfTime,
  );
  return {
    id: whole(o.id, "vote.open.id", COUNT_LIMIT),
    kind,
    phase,
    openedAt,
    standEnd,
    voteEnd,
    effectiveAt,
    supply,
    floor,
    cast,
    options,
    result,
    carriedOutAt,
  };
}

/** Before `voteEnd` there is no result: the record may leave it out; a `null` reads as none. */
function absentResult(raw: unknown): null {
  if (raw !== null && raw !== undefined) fail("vote.open.result");
  return null;
}

function readNext(
  raw: unknown,
  council: CouncilNumbers | null,
): VoteNextNumbers {
  const n = obj(raw, "vote.next");
  const seatsAt = timeOrNull(n.seatsAt, "vote.next.seatsAt");
  const replaceFrom = timeOrNull(n.replaceFrom, "vote.next.replaceFrom");
  // The election the record names for the vote is the Council's own next election.
  if (council !== null && seatsAt !== null && seatsAt !== council.nextElection)
    fail("vote.next.seatsAt");
  return {
    seatsAt,
    replaceFrom,
    openFloor: amount(n.openFloor, "vote.next.openFloor"),
  };
}

/**
 * The record's `vote` block, checked: every number a sentence needs, the ballot worth showing and the next openings.
 * Throws when any check fails; the caller reads that as "the vote is null and the rest stands".
 */
export function readVote(
  raw: unknown,
  ctx: VoteContext,
  council: CouncilNumbers | null,
): VoteNumbers {
  const v = obj(raw, "vote");
  const contract = address(v.contract, "vote.contract");
  // The vote contract is the project's pause, when the record names one.
  if (
    ctx.contractsPause !== undefined &&
    ctx.contractsPause !== null &&
    ctx.contractsPause !== contract
  )
    fail("vote.contract");
  const rule = readRule(v.rule);
  // The Council the vote seats has the rule's own shape.
  if (council) {
    if (rule.seats !== council.seats.length) fail("vote.rule.seats");
    if (rule.needed !== council.needed) fail("vote.rule.needed");
  }
  return {
    contract,
    rule,
    open: v.open === null ? null : readOpen(v.open, rule, ctx),
    next: readNext(v.next, council),
  };
}
