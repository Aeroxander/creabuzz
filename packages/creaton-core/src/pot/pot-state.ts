/**
 * More reads for the screens that run a project (the allowance, the grants) and for a take-out that cannot lean on the
 * server's record: the allowance box as the chain has it, a grant, the faucet's use, and a project's contracts as the
 * Launcher knows them. Like `pot-reads.ts`: strict, and an answer that is too short or the wrong shape throws. A screen
 * that gets a throw says so; it never falls back to the server's record.
 */
import type { Abi } from "./abi-codec.ts";
import {
  HOLDER_PAUSE_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";
import { ask, asBigint, type ReadCall } from "./pot-reads.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const asAddress = (value: unknown): string => {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new Error("An address was expected.");
  return value.toLowerCase();
};

const asNumber = (value: unknown): number => {
  const n = asBigint(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("A number was too large to read.");
  return Number(n);
};

/** Read one value of a view with no arguments. */
async function one(
  read: ReadCall,
  abi: Abi,
  to: string,
  name: string,
): Promise<unknown> {
  const [value] = await ask(read, abi, to, name, []);
  return value;
}

/** The allowance box and the clock around it, as the Treasury holds them now. */
export interface AllowanceState {
  /** What the team may draw now, in dollar units (as of the last settle: a draw settles first, so it may be a little more). */
  box: bigint;
  boxCap: bigint;
  /** The daily rate, in parts per million of the project's money a day. */
  ratePpm: number;
  /** An announced raise: its rate and when it can be applied (announced at + one time unit), or null. */
  pending: { ratePpm: number; applicableAt: number } | null;
  /** The last check-in (unix seconds) and the end of the time the project counts as active (0 when none). */
  lastCheckIn: number;
  activeEnd: number;
  /** The most the rate can be set to, in parts per million. */
  maxRatePpm: number;
}

/** The allowance box, rate, announced raise and check-in clock at the chain's latest block. */
export async function readAllowanceState(
  read: ReadCall,
  treasury: string,
): Promise<AllowanceState> {
  const [
    box,
    boxCap,
    ratePpm,
    pendingPpm,
    pendingAt,
    lastCheckIn,
    activeEnd,
    max,
    unit,
  ] = await Promise.all(
    [
      "box",
      "boxCap",
      "ratePpm",
      "pendingRatePpm",
      "pendingAt",
      "lastCheckIn",
      "activeEnd",
      "MAX_RATE_PPM",
      "unit",
    ].map((name) => one(read, TREASURY_ABI, treasury, name)),
  );
  const pendingTime = asNumber(pendingAt);
  return {
    box: asBigint(box),
    boxCap: asBigint(boxCap),
    ratePpm: asNumber(ratePpm),
    pending:
      pendingTime > 0
        ? // `pendingAt` is when the raise was announced; it can be applied one time unit later (`applyRate` reverts `NotYet`).
          {
            ratePpm: asNumber(pendingPpm),
            applicableAt: pendingTime + asNumber(unit),
          }
        : null,
    lastCheckIn: asNumber(lastCheckIn),
    activeEnd: asNumber(activeEnd),
    maxRatePpm: asNumber(max),
  };
}

/** The allowance box as the Treasury holds it now (as of its last settle: a draw settles first, so it can then hold more). */
export async function boxOf(read: ReadCall, treasury: string): Promise<bigint> {
  return asBigint(await one(read, TREASURY_ABI, treasury, "box"));
}

/** The daily rate now, in parts per million of the project's money a day (`Treasury.ratePpm`). */
export async function ratePpmNow(
  read: ReadCall,
  treasury: string,
): Promise<number> {
  return asNumber(await one(read, TREASURY_ABI, treasury, "ratePpm"));
}

/** Whether `account` has already taken its play dollars from the faucet (`PlayDollar.faucetUsed`). */
export async function faucetUsedBy(
  read: ReadCall,
  dollar: string,
  account: string,
): Promise<boolean> {
  const [used] = await ask(read, PLAY_DOLLAR_ABI, dollar, "faucetUsed", [
    account,
  ]);
  if (typeof used !== "boolean") throw new Error("A yes or no was expected.");
  return used;
}

/** What the faucet gives, in dollar units (`PlayDollar.FAUCET_AMOUNT`). */
export async function faucetAmount(
  read: ReadCall,
  dollar: string,
): Promise<bigint> {
  return asBigint(await one(read, PLAY_DOLLAR_ABI, dollar, "FAUCET_AMOUNT"));
}

/** One grant as the Vester holds it. */
export interface GrantOnChain {
  member: string;
  /** A protected grant vests on calendar time and cannot be given up. */
  protectedGrant: boolean;
  /** 0 live, 1 announced to burn, 2 closed (the Vester's own numbering). */
  state: number;
  burnAt: number;
  total: bigint;
  claimed: bigint;
  burn: bigint;
}

/** `Vester.grantOf(id)`. */
export async function readGrant(
  read: ReadCall,
  vester: string,
  id: bigint,
): Promise<GrantOnChain> {
  const [grant] = await ask(read, VESTER_ABI, vester, "grantOf", [id]);
  if (!Array.isArray(grant) || grant.length < 8)
    throw new Error("A grant was expected.");
  const [member, isProtected, state, burnAt, total, claimed, , burn] = grant;
  if (typeof isProtected !== "boolean")
    throw new Error("A yes or no was expected.");
  return {
    member: asAddress(member),
    protectedGrant: isProtected,
    state: asNumber(state),
    burnAt: asNumber(burnAt),
    total: asBigint(total),
    claimed: asBigint(claimed),
    burn: asBigint(burn),
  };
}

/** What a grant has built up so far with no cliff: what a member keeps on their own exit (`Vester.accruedOf`). */
export async function accruedOf(
  read: ReadCall,
  vester: string,
  id: bigint,
): Promise<bigint> {
  const [value] = await ask(read, VESTER_ABI, vester, "accruedOf", [id]);
  return asBigint(value);
}

/** The parts of a project as the Launcher knows them. */
export interface ProjectParts {
  founder: string;
  shares: string;
  team: string;
  treasury: string;
  vester: string;
  launchedAt: number;
}

/** `Launcher.projectByKey(key)`: where a project's contracts are, without the server's record. */
export async function readProjectParts(
  read: ReadCall,
  launcher: string,
  key: string,
): Promise<ProjectParts> {
  const [tuple] = await ask(read, LAUNCHER_ABI, launcher, "projectByKey", [
    key,
  ]);
  if (!Array.isArray(tuple) || tuple.length < 6)
    throw new Error("A project was expected.");
  const [founder, shares, team, treasury, vester, launchedAt] = tuple;
  const parts = {
    founder: asAddress(founder),
    shares: asAddress(shares),
    team: asAddress(team),
    treasury: asAddress(treasury),
    vester: asAddress(vester),
    launchedAt: asNumber(launchedAt),
  };
  // An unknown key reads as a project of empty addresses: that is "not here", never a place to send money.
  if (/^0x0{40}$/.test(parts.treasury))
    throw new Error("The network does not know this project.");
  return parts;
}

/** The dollar the platform's projects are in (`Launcher.platform().quote`). */
export async function readPlatformDollar(
  read: ReadCall,
  launcher: string,
): Promise<string> {
  const [quote] = await ask(read, LAUNCHER_ABI, launcher, "platform", []);
  return asAddress(quote);
}

/** How long a call waits in a Pair before it is out of time, in seconds (`Pair.PROPOSAL_TTL`: read, never copied). */
export async function proposalTtl(
  read: ReadCall,
  pair: string,
): Promise<number> {
  return asNumber(await one(read, PAIR_ABI, pair, "PROPOSAL_TTL"));
}

/** A call waiting in a Pair: who proposed it and when, or null when it ran, was withdrawn or never was. */
export async function readProposal(
  read: ReadCall,
  pair: string,
  id: string,
): Promise<{ proposer: string; proposedAt: number } | null> {
  const [by] = await ask(read, PAIR_ABI, pair, "proposer", [id]);
  const proposer = asAddress(by);
  if (/^0x0{40}$/.test(proposer)) return null;
  const [at] = await ask(read, PAIR_ABI, pair, "proposedAt", [id]);
  return { proposer, proposedAt: asNumber(at) };
}

/**
 * What the Launcher would give a project launched now: the hash of its settings (the founder passes it to `launch`, which
 * refuses if the settings changed since), the platform's own limits, and the two ceilings a founder's numbers must stay under.
 */
export interface LaunchOffer {
  /** `settingsHash()`: 32 bytes as 0x hex. */
  settingsHash: string;
  /** The dollar the project is in. */
  dollar: string;
  /** The platform's part of money going in, in ten-thousandths (200 is 2%). */
  feeBps: number;
  /** The time unit in seconds (7 days on a real network). */
  unit: number;
  /** The daily dollar limit a helper (an agent) gets by default, in dollar units. */
  agentUsd: bigint;
  /** The most the allowance rate may be, in parts per million of the project's money a day. */
  maxRatePpm: number;
  /**
   * The holder pause's code this deployment gives every new project (`Launcher.holderPauseImpl`), lower case, or null when the
   * deployment's switch is off. A project is born with the pause or without it for good, so a founder is told before launching.
   */
  holderPause: { impl: string; lineDivisor: number } | null;
  /** The most Team Shares a founder may ask for at birth, in raw units (18 decimals). */
  maxTeamPool: bigint;
  /** A Team Share helper's daily limit is the pool divided by this. */
  agentShareDiv: bigint;
  /** The rules every project is born with, read from the contracts a project is cloned from (no copy of them lives here). */
  rules: {
    /** The smallest amount that can back, in dollar units. */
    minJoin: bigint;
    /** Time units without a check-in before new backing and the allowance stop. */
    checkInUnits: number;
    /** Time units without a check-in before anyone may wind the project down. */
    windDownUnits: number;
    /** Time units before a Team grant starts to unlock, and in all until it has unlocked. */
    cliffUnits: number;
    vestUnits: number;
  };
}

/** The Launcher's settings, hash and ceilings at the chain's latest block. */
export async function readLaunchOffer(
  read: ReadCall,
  launcher: string,
): Promise<LaunchOffer> {
  const [
    hash,
    platform,
    maxRate,
    maxPool,
    agentDiv,
    treasuryImpl,
    vesterImpl,
    pauseImpl,
  ] = await Promise.all([
    one(read, LAUNCHER_ABI, launcher, "settingsHash"),
    ask(read, LAUNCHER_ABI, launcher, "platform", []),
    one(read, LAUNCHER_ABI, launcher, "MAX_RATE_PPM"),
    one(read, LAUNCHER_ABI, launcher, "MAX_TEAM_POOL"),
    one(read, LAUNCHER_ABI, launcher, "AGENT_SHARE_DIV"),
    one(read, LAUNCHER_ABI, launcher, "treasuryImpl"),
    one(read, LAUNCHER_ABI, launcher, "vesterImpl"),
    one(read, LAUNCHER_ABI, launcher, "holderPauseImpl"),
  ]);
  const treasuryCode = asAddress(treasuryImpl);
  const vesterCode = asAddress(vesterImpl);
  const [minJoin, checkIn, windDown, cliff, vest] = await Promise.all([
    one(read, TREASURY_ABI, treasuryCode, "MIN_JOIN"),
    one(read, TREASURY_ABI, treasuryCode, "CHECK_IN_MULT"),
    one(read, TREASURY_ABI, treasuryCode, "WIND_MULT"),
    one(read, VESTER_ABI, vesterCode, "CLIFF_MULT"),
    one(read, VESTER_ABI, vesterCode, "VEST_MULT"),
  ]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("A settings hash was expected.");
  // The pause's line is a constant of its code: read it, so the words a founder reads are the contract's own.
  const pauseCode = asAddress(pauseImpl).toLowerCase();
  let holderPause: LaunchOffer["holderPause"] = null;
  if (!/^0x0{40}$/.test(pauseCode)) {
    const divisor = asNumber(
      await one(read, HOLDER_PAUSE_ABI, pauseCode, "LINE_DIVISOR"),
    );
    if (divisor < 2 || divisor > 100)
      throw new Error("The network gave an answer that is not readable.");
    holderPause = { impl: pauseCode, lineDivisor: divisor };
  }
  const [quote, , feeBps, unit, agentUsd] = platform;
  return {
    settingsHash: hash.toLowerCase(),
    dollar: asAddress(quote),
    feeBps: asNumber(feeBps),
    unit: asNumber(unit),
    agentUsd: asBigint(agentUsd),
    holderPause,
    maxRatePpm: asNumber(maxRate),
    maxTeamPool: asBigint(maxPool),
    agentShareDiv: asBigint(agentDiv),
    rules: {
      minJoin: asBigint(minJoin),
      checkInUnits: asNumber(checkIn),
      windDownUnits: asNumber(windDown),
      cliffUnits: asNumber(cliff),
      vestUnits: asNumber(vest),
    },
  };
}

/** The address the Pair of (`first`, `second`) will have for project `key` (`Launcher.pairAddress`). */
export async function pairAddressOf(
  read: ReadCall,
  launcher: string,
  key: string,
  first: string,
  second: string,
): Promise<string> {
  const [pair] = await ask(read, LAUNCHER_ABI, launcher, "pairAddress", [
    key,
    first,
    second,
  ]);
  return asAddress(pair);
}

/** Who runs a project's money and what is being offered to whom, as the Treasury has it now. */
export interface SeatState {
  /** The account that runs the money: the founder, whoever took the seat, or the Pair. */
  runner: string;
  founder: string;
  /** Who the seat is offered to, or null when no offer is open. */
  offeredTo: string | null;
  /** When the offer was made (0 when none). */
  offeredAt: number;
  /** The offer ends this many seconds after it was made (`SEAT_OFFER_MULT` time units). */
  offerLasts: number;
  /** Taking the seat also trims the founder's own Team Shares that have not unlocked. */
  founderLeaves: boolean;
  /** 0 not wound down, 1 by the runner, 2 after a long quiet. */
  windDownKind: number;
}

/** The seat, any offer for it, and the wind-down state at the chain's latest block. */
export async function readSeatState(
  read: ReadCall,
  treasury: string,
): Promise<SeatState> {
  const [runner, founder, pending, pendingAt, trim, mult, unit, kind] =
    await Promise.all(
      [
        "runner",
        "founder",
        "pendingRunner",
        "pendingSeatAt",
        "pendingTrim",
        "SEAT_OFFER_MULT",
        "unit",
        "windDownKind",
      ].map((name) => one(read, TREASURY_ABI, treasury, name)),
    );
  const offered = asAddress(pending);
  if (typeof trim !== "boolean") throw new Error("A yes or no was expected.");
  return {
    runner: asAddress(runner),
    founder: asAddress(founder),
    offeredTo: /^0x0{40}$/.test(offered) ? null : offered,
    offeredAt: asNumber(pendingAt),
    offerLasts: asNumber(mult) * asNumber(unit),
    founderLeaves: trim,
    windDownKind: asNumber(kind),
  };
}
