/**
 * The step 4 keys of a record (`docs/next-version/RECORD-V2.md` section 13): `pause`, `earlierGrants`, `contracts.pause` and
 * the team's `earlierPool` and `earlierReserve`. Each is read apart from the money, the way the step 3 keys are: a key that is
 * missing (a record signed before step 4) is left out; one that is `null`, malformed or at odds with the record's own numbers
 * reads as `null` for that key only, and the rest of the record stands. Never throws, never touches the money, unlocks
 * nothing: it decides what a screen says, and the chain decides what a press does.
 *
 * "Missing" and "null" are kept apart where it matters: a record with no `pause` key and one with `pause: null` both mean
 * "no stop is shown" (the app never guesses that a project has one), but `contracts.pause` set with `pause` null tells the
 * holder's park sheet that the stop exists and could not be read right now.
 */
import {
  address,
  amount,
  bool,
  fail,
  type Json,
  isObject,
  obj,
  time,
  timeOrNull,
  whole,
  bytes32,
} from "./numbers-strict";
import type { EarlierGrantsNumbers, PauseNumbers } from "./numbers-types";

/** The line may be one this-many-th of the backers' Shares: the server signs nothing outside 2 to 100. */
const DIVISOR_MIN = 2;
const DIVISOR_MAX = 100;
const PEOPLE_MAX = 1_000_000;
const ROWS_MAX = 2 ** 32 - 1;

/** What the keys are checked against: all from the money part of the same record. */
export interface Step4Context {
  asOfTime: number;
  unit: number;
  /** The backers' Shares, parked ones included. */
  backers: bigint;
}

/** What the step 4 keys of one record say; a field left out here was missing from the record. */
export interface Step4Keys {
  /** `contracts.pause`: the project's pause contract, or null (none, or not believed). Left out for an older record. */
  contractsPause?: string | null;
  pause?: PauseNumbers | null;
  earlierGrants?: EarlierGrantsNumbers | null;
  /** `team.earlierPool` and `team.earlierReserve`: both set or both null. Left out for an older record. */
  earlier?: { pool: bigint; reserve: bigint } | null;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function readPause(
  raw: unknown,
  ctx: Step4Context,
  contractsPause: string | null | undefined,
): PauseNumbers {
  const p = obj(raw, "pause");
  const contract = address(p.contract, "pause.contract");
  // The stop and the record's own contract list name the same contract.
  if (contractsPause && contractsPause !== contract) fail("pause.contract");
  const parkedTotal = amount(p.parkedTotal, "pause.parkedTotal");
  const line = amount(p.line, "pause.line");
  const dayLength = whole(p.dayLength, "pause.dayLength", 365 * 86_400);
  const lineDivisor = whole(p.lineDivisor, "pause.lineDivisor", DIVISOR_MAX);
  if (lineDivisor < DIVISOR_MIN) fail("pause.lineDivisor");
  const armedAt = timeOrNull(p.armedAt, "pause.armedAt");
  const pausesFrom = timeOrNull(p.pausesFrom, "pause.pausesFrom");
  const paused = bool(p.paused, "pause.paused");
  const since = timeOrNull(p.since, "pause.since");
  const parkerCount = whole(p.parkerCount, "pause.parkerCount", PEOPLE_MAX);

  // More Shares parked than backers hold cannot be.
  if (parkedTotal > ctx.backers) fail("pause.parkedTotal");
  // The line is the backers' Shares over the divisor, rounded up.
  if (line !== ceilDiv(ctx.backers, BigInt(lineDivisor))) fail("pause.line");
  // The warning period is a seventh of the time unit.
  if (dayLength === 0 || dayLength !== Math.floor(ctx.unit / 7))
    fail("pause.dayLength");
  // Armed and its start go together, a day apart; the clock cannot start after the record's own time.
  if ((armedAt === null) !== (pausesFrom === null)) fail("pause.armedAt");
  if (armedAt !== null && pausesFrom !== null) {
    if (armedAt > ctx.asOfTime) fail("pause.armedAt");
    if (pausesFrom !== armedAt + dayLength) fail("pause.pausesFrom");
  }
  // Paused is the rule on the record's own numbers, and `since` is the start exactly while paused.
  const reached =
    ctx.backers > 0n && parkedTotal * BigInt(lineDivisor) >= ctx.backers;
  const worked = pausesFrom !== null && ctx.asOfTime >= pausesFrom && reached;
  if (paused !== worked) fail("pause.paused");
  if (paused ? since !== pausesFrom : since !== null) fail("pause.since");
  // A count of parkers, and none exactly when nothing is parked.
  if ((parkerCount === 0) !== (parkedTotal === 0n)) fail("pause.parkerCount");
  return {
    contract,
    parkedTotal,
    line,
    dayLength,
    lineDivisor,
    armedAt,
    pausesFrom,
    paused,
    since,
    parkerCount,
  };
}

function readEarlier(raw: unknown, pool: bigint | null): EarlierGrantsNumbers {
  const e = obj(raw, "earlierGrants");
  const total = amount(e.total, "earlierGrants.total");
  const rows = whole(e.rows, "earlierGrants.rows", ROWS_MAX);
  if (rows === 0) fail("earlierGrants.rows");
  const claimedRows = whole(
    e.claimedRows,
    "earlierGrants.claimedRows",
    ROWS_MAX,
  );
  const claimedTotal = amount(e.claimedTotal, "earlierGrants.claimedTotal");
  if (claimedRows > rows) fail("earlierGrants.claimedRows");
  if (claimedTotal > total) fail("earlierGrants.claimedTotal");
  // The pool the claim contract names is the pool the record's team part names.
  if (pool !== null && pool !== total) fail("earlierGrants.total");
  const clockSecs = time(e.clockSecs, "earlierGrants.clockSecs");
  if (clockSecs === 0) fail("earlierGrants.clockSecs");
  return {
    contract: address(e.contract, "earlierGrants.contract"),
    bound: bool(e.bound, "earlierGrants.bound"),
    root: bytes32(e.root, "earlierGrants.root"),
    textHash: bytes32(e.textHash, "earlierGrants.textHash"),
    total,
    rows,
    claimedRows,
    claimedTotal,
    clockSecs,
  };
}

function readTeamEarlier(team: Json): { pool: bigint; reserve: bigint } | null {
  const pool = team.earlierPool;
  const reserve = team.earlierReserve;
  if (pool === null || pool === undefined) {
    // Both or neither.
    if (reserve !== null && reserve !== undefined) fail("team.earlierReserve");
    return null;
  }
  const p = amount(pool, "team.earlierPool");
  const r = amount(reserve, "team.earlierReserve");
  if (r > p) fail("team.earlierReserve");
  return { pool: p, reserve: r };
}

function apart<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * The step 4 keys of a record body: a key that is missing is left out of the result, one that is null or cannot be believed
 * is null. Never throws and never touches the money.
 */
export function readStep4(body: Json, ctx: Step4Context): Step4Keys {
  const out: Step4Keys = {};
  if (!isObject(body)) return out;
  const contracts = isObject(body.contracts) ? body.contracts : {};
  if ("pause" in contracts)
    out.contractsPause =
      contracts.pause === null
        ? null
        : apart(() => address(contracts.pause, "contracts.pause"));
  const team = isObject(body.team) ? body.team : {};
  if ("earlierPool" in team || "earlierReserve" in team)
    out.earlier = apart(() => readTeamEarlier(team));
  if ("pause" in body)
    out.pause =
      body.pause === null
        ? null
        : apart(() => readPause(body.pause, ctx, out.contractsPause));
  if ("earlierGrants" in body)
    out.earlierGrants =
      body.earlierGrants === null
        ? null
        : apart(() =>
            readEarlier(
              body.earlierGrants,
              out.earlier ? out.earlier.pool : null,
            ),
          );
  return out;
}
