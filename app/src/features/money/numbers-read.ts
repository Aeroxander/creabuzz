/**
 * The strict reading of a version 2 record's body (`docs/next-version/RECORD-V2.md`, section 2): every field is required
 * and checked, and anything that cannot be believed throws `Unreadable`, which `parseNumbers` turns into "cannot read".
 * No field falls back to a default number.
 */
import type {
  AgentNumbers,
  GrantNumbers,
  HolderNumbers,
  ProjectNumbers,
  QuietState,
} from "./numbers-types";

const QUIET_STATES: readonly QuietState[] = [
  "active",
  "quiet",
  "dormant",
  "may_wind_down",
  "wound_down",
];

// --- Strict reading -----------------------------------------------------------------------------------------------

/** A value the record carried that cannot be believed: thrown inside the parser, turned into null at its edge. */
class Unreadable extends Error {}

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9]\d{0,38})$/;
/** The most any amount can be: 2^128. Far beyond any dollar or Share count the contracts allow. */
const AMOUNT_LIMIT = 1n << 128n;
/** The latest time the record may name: far past any real clock, short of anything that overflows. */
const TIME_LIMIT = 2 ** 40;
const COUNT_LIMIT = 1_000_000_000;

function fail(path: string): never {
  throw new Unreadable(path);
}

export function obj(v: unknown, path: string): Json {
  return isObject(v) ? v : fail(path);
}
function arr(v: unknown, path: string, max: number): unknown[] {
  return Array.isArray(v) && v.length <= max ? v : fail(path);
}
function bool(v: unknown, path: string): boolean {
  return typeof v === "boolean" ? v : fail(path);
}
function amount(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v)) return fail(path);
  const n = BigInt(v);
  return n < AMOUNT_LIMIT ? n : fail(path);
}
function whole(v: unknown, path: string, max: number): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max
    ? v
    : fail(path);
}
export const time = (v: unknown, path: string) => whole(v, path, TIME_LIMIT);
const count = (v: unknown, path: string) => whole(v, path, COUNT_LIMIT);
function timeOrNull(v: unknown, path: string): number | null {
  return v === null ? null : time(v, path);
}
function address(v: unknown, path: string): string {
  return typeof v === "string" && ADDRESS.test(v) ? v : fail(path);
}
function addressOrNull(v: unknown, path: string): string | null {
  return v === null ? null : address(v, path);
}
function bytes32(v: unknown, path: string): string {
  return typeof v === "string" && BYTES32.test(v) ? v : fail(path);
}
function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  path: string,
): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fail(path);
}

const CAPS = { holders: 200, grants: 200, agents: 50 } as const;

function readGrant(raw: unknown, at: string): GrantNumbers {
  const g = obj(raw, at);
  const state = oneOf(g.state, ["live", "announced", "closed"], `${at}.state`);
  const cliffRaw = g.cliff;
  const forfeitRaw = g.forfeit;
  const forfeit =
    forfeitRaw === null
      ? null
      : (() => {
          const f = obj(forfeitRaw, `${at}.forfeit`);
          return {
            amount: amount(f.amount, `${at}.forfeit.amount`),
            burnAt: time(f.burnAt, `${at}.forfeit.burnAt`),
            byMember: bool(f.byMember, `${at}.forfeit.byMember`),
          };
        })();
  // A notice is running exactly while the grant is announced.
  if ((state === "announced") !== (forfeit !== null)) fail(`${at}.forfeit`);
  const cliff =
    cliffRaw === null
      ? null
      : (() => {
          const c = obj(cliffRaw, `${at}.cliff`);
          return {
            passed: bool(c.passed, `${at}.cliff.passed`),
            endsAtIfActive: timeOrNull(
              c.endsAtIfActive,
              `${at}.cliff.endsAtIfActive`,
            ),
          };
        })();
  const granted = amount(g.granted, `${at}.granted`);
  const keeps = amount(g.keeps, `${at}.keeps`);
  const claimed = amount(g.claimed, `${at}.claimed`);
  const vested = amount(g.vested, `${at}.vested`);
  const claimable = amount(g.claimable, `${at}.claimable`);
  // What is claimable is what is vested and not yet claimed; neither can pass what the member keeps.
  if (claimed > keeps || vested > keeps || claimed > vested)
    fail(`${at}.vested`);
  if (claimable !== vested - claimed) fail(`${at}.claimable`);
  return {
    id: count(g.id, `${at}.id`),
    member: address(g.member, `${at}.member`),
    kind: oneOf(g.kind, ["normal", "protected"], `${at}.kind`),
    state,
    granted,
    keeps,
    claimed,
    vested,
    claimable,
    startActive: whole(g.startActive, `${at}.startActive`, TIME_LIMIT),
    cliff,
    fullyVestedAtIfActive: timeOrNull(
      g.fullyVestedAtIfActive,
      `${at}.fullyVestedAtIfActive`,
    ),
    forfeit,
  };
}

function readAgent(raw: unknown, at: string): AgentNumbers {
  const a = obj(raw, at);
  return {
    agent: address(a.agent, `${at}.agent`),
    live: bool(a.live, `${at}.live`),
    usdCap: amount(a.usdCap, `${at}.usdCap`),
    teamCap: amount(a.teamCap, `${at}.teamCap`),
    usdUsed: amount(a.usdUsed, `${at}.usdUsed`),
    teamUsed: amount(a.teamUsed, `${at}.teamUsed`),
  };
}

function readHolder(raw: unknown, at: string): HolderNumbers {
  const h = obj(raw, at);
  return {
    account: address(h.account, `${at}.account`),
    shares: amount(h.shares, `${at}.shares`),
    teamShares: amount(h.teamShares, `${at}.teamShares`),
  };
}

/** The whole version 2 body, or throws `Unreadable`. */
export function readBody(body: Json, key: string): ProjectNumbers {
  const contracts = obj(body.contracts, "contracts");
  const asOf = obj(body.asOf, "asOf");
  const money = obj(body.money, "money");
  const shares = obj(body.shares, "shares");
  const value = obj(body.value, "value");
  const allowance = obj(body.allowance, "allowance");
  const clock = obj(body.clock, "clock");
  const door = obj(body.door, "door");
  const quiet = obj(body.quiet, "quiet");
  const runner = obj(body.runner, "runner");
  const team = obj(body.team, "team");
  const limits = obj(body.limits, "limits");
  const totals = obj(body.totals, "totals");
  const fee = obj(body.fee, "fee");

  const pendingRaw = allowance.pending;
  const pending =
    pendingRaw === null
      ? null
      : (() => {
          const p = obj(pendingRaw, "allowance.pending");
          return {
            ratePpm: whole(p.ratePpm, "allowance.pending.ratePpm", 1_000_000),
            proposedAt: time(p.proposedAt, "allowance.pending.proposedAt"),
            applicableAt: time(
              p.applicableAt,
              "allowance.pending.applicableAt",
            ),
          };
        })();

  const nextRaw = quiet.next;
  const next =
    nextRaw === null
      ? null
      : (() => {
          const n = obj(nextRaw, "quiet.next");
          return {
            state: oneOf(n.state, QUIET_STATES, "quiet.next.state"),
            at: time(n.at, "quiet.next.at"),
          };
        })();

  const windRaw = body.windDown;
  const windDown =
    windRaw === null
      ? null
      : (() => {
          const w = obj(windRaw, "windDown");
          if (w.kind !== 1 && w.kind !== 2) fail("windDown.kind");
          return { kind: w.kind as 1 | 2, at: time(w.at, "windDown.at") };
        })();

  const signersRaw = runner.signers;
  const signers =
    signersRaw === null
      ? null
      : (() => {
          const list = arr(signersRaw, "runner.signers", 2);
          if (list.length !== 2) fail("runner.signers");
          return [
            address(list[0], "runner.signers[0]"),
            address(list[1], "runner.signers[1]"),
          ] as [string, string];
        })();
  const isPair = bool(runner.isPair, "runner.isPair");
  // A Pair has its two signers; a lone runner has none.
  if (isPair !== (signers !== null)) fail("runner.signers");

  const state = oneOf(quiet.state, QUIET_STATES, "quiet.state");
  // A wound-down project and a "wound_down" state go together.
  if ((state === "wound_down") !== (windDown !== null)) fail("quiet.state");

  const arrivalEnd = timeOrNull(money.arrivalEnd, "money.arrivalEnd");
  const arriving = amount(money.arriving, "money.arriving");
  if ((arriving === 0n) !== (arrivalEnd === null)) fail("money.arrivalEnd");

  const holders = arr(body.holders, "holders", CAPS.holders).map((h, i) =>
    readHolder(h, `holders[${i}]`),
  );
  const grants = arr(team.grants, "team.grants", CAPS.grants).map((g, i) =>
    readGrant(g, `team.grants[${i}]`),
  );
  const agents = arr(body.agents, "agents", CAPS.agents).map((a, i) =>
    readAgent(a, `agents[${i}]`),
  );
  const refreshEverySecs = whole(
    body.refreshEverySecs,
    "refreshEverySecs",
    86_400,
  );
  // The server promises 600 or 3600; its operator may set it as low as 5 seconds (a test network showing the cadence), so
  // 5 is the least believed: a record that promises less is nonsense, one that promises more than a day is too (above).
  if (refreshEverySecs < 5) fail("refreshEverySecs");
  const unit = whole(body.unit, "unit", 365 * 86_400);
  if (unit === 0) fail("unit");

  return {
    removed: false,
    version: 2,
    key,
    projectId: bytes32(body.projectId, "projectId"),
    founder: address(body.founder, "founder"),
    chainId: whole(body.chainId, "chainId", COUNT_LIMIT),
    launcher: address(body.launcher, "launcher"),
    launchedAt: time(body.launchedAt, "launchedAt"),
    // The one lenient field: a record that does not say counts as play money (the safe answer, S7).
    playMoney: body.playMoney !== false,
    contracts: {
      treasury: address(contracts.treasury, "contracts.treasury"),
      shares: address(contracts.shares, "contracts.shares"),
      team: address(contracts.team, "contracts.team"),
      vester: address(contracts.vester, "contracts.vester"),
      dollar: address(contracts.dollar, "contracts.dollar"),
      pair: addressOrNull(contracts.pair, "contracts.pair"),
    },
    unit,
    feeBps: whole(fee.bps, "fee.bps", 10_000),
    asOf: {
      block: whole(asOf.block, "asOf.block", COUNT_LIMIT * 1000),
      time: time(asOf.time, "asOf.time"),
    },
    builtAt: time(body.builtAt, "builtAt"),
    refreshEverySecs,
    money: {
      pot: amount(money.pot, "money.pot"),
      paidIn: amount(money.paidIn, "money.paidIn"),
      arriving,
      arrivalEnd,
      feesOwed: amount(money.feesOwed, "money.feesOwed"),
      locked: amount(money.locked, "money.locked"),
      notesOwed: amount(money.notesOwed, "money.notesOwed"),
      held: amount(money.held, "money.held"),
    },
    shares: {
      backers: amount(shares.backers, "shares.backers"),
      teamCounted: amount(shares.teamCounted, "shares.teamCounted"),
      announcedBurn: amount(shares.announcedBurn, "shares.announcedBurn"),
    },
    value: {
      leaveValue: amount(value.leaveValue, "value.leaveValue"),
      teamValue: amount(value.teamValue, "value.teamValue"),
    },
    allowance: {
      ratePpm: whole(allowance.ratePpm, "allowance.ratePpm", 1_000_000),
      pending,
      box: amount(allowance.box, "allowance.box"),
      boxCap: amount(allowance.boxCap, "allowance.boxCap"),
      drawnLastDay: amount(allowance.drawnLastDay, "allowance.drawnLastDay"),
    },
    clock: {
      lastCheckIn: time(clock.lastCheckIn, "clock.lastCheckIn"),
      lastRecordHash:
        clock.lastRecordHash === null
          ? null
          : bytes32(clock.lastRecordHash, "clock.lastRecordHash"),
      activeUntil: timeOrNull(clock.activeUntil, "clock.activeUntil"),
      activeSeconds: time(clock.activeSeconds, "clock.activeSeconds"),
    },
    door: {
      switchOn: bool(door.switchOn, "door.switchOn"),
      openNow: bool(door.openNow, "door.openNow"),
      shutsAt: timeOrNull(door.shutsAt, "door.shutsAt"),
    },
    quiet: {
      state,
      since: time(quiet.since, "quiet.since"),
      quietFrom: timeOrNull(quiet.quietFrom, "quiet.quietFrom"),
      dormantFrom: timeOrNull(quiet.dormantFrom, "quiet.dormantFrom"),
      windableFrom: timeOrNull(quiet.windableFrom, "quiet.windableFrom"),
      next,
    },
    windDown,
    runner: {
      address: address(runner.address, "runner.address"),
      isPair,
      signers,
    },
    team: {
      pool: amount(team.pool, "team.pool"),
      inHands: amount(team.inHands, "team.inHands"),
      inVester: amount(team.inVester, "team.inVester"),
      promised: amount(team.promised, "team.promised"),
      ungranted: amount(team.ungranted, "team.ungranted"),
      grantCount: count(team.grantCount, "team.grantCount"),
      grants,
    },
    agents,
    limits: {
      minJoin: amount(limits.minJoin, "limits.minJoin"),
      minOutsidePayment: amount(
        limits.minOutsidePayment,
        "limits.minOutsidePayment",
      ),
      maxRatePpm: whole(limits.maxRatePpm, "limits.maxRatePpm", 1_000_000),
      checkInWindowUnits: count(
        limits.checkInWindowUnits,
        "limits.checkInWindowUnits",
      ),
      windDownUnits: count(limits.windDownUnits, "limits.windDownUnits"),
      cliffUnits: count(limits.cliffUnits, "limits.cliffUnits"),
      vestUnits: count(limits.vestUnits, "limits.vestUnits"),
      minGrant: amount(limits.minGrant, "limits.minGrant"),
      maxGrantsPerMember: count(
        limits.maxGrantsPerMember,
        "limits.maxGrantsPerMember",
      ),
      agentUsdPerDay: amount(limits.agentUsdPerDay, "limits.agentUsdPerDay"),
      agentTeamPerDay: amount(limits.agentTeamPerDay, "limits.agentTeamPerDay"),
    },
    totals: {
      joined: amount(totals.joined, "totals.joined"),
      fees: amount(totals.fees, "totals.fees"),
      tookOut: amount(totals.tookOut, "totals.tookOut"),
      drawn: amount(totals.drawn, "totals.drawn"),
      outside: amount(totals.outside, "totals.outside"),
    },
    firstBackedAt: timeOrNull(body.firstBackedAt, "firstBackedAt"),
    holders,
    holderCount: count(body.holderCount, "holderCount"),
    teamHolderCount: count(body.teamHolderCount, "teamHolderCount"),
    truncated: bool(body.truncated, "truncated"),
  };
}
