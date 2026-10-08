/**
 * Launching a project into a DAO it does not control, in one transaction (`contracts/src/DaoLaunchKit.sol`).
 *
 * The old launch sold a token the founder minted and paid the raise to a wallet the founder chose. This path sells
 * the DAO's own Shares, holds back the team's allocation until its milestones, and settles the raise into the DAO, all in one atomic call, so
 * the client's job shrinks to: validate the plan, ask the kit where the executor will be (the auction config has to
 * name it), send one transaction, read one event.
 *
 * Pure: inputs in, bytes out. Covered by `daoLaunch.test.mjs`, whose golden calldata is `cast calldata`'s.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  type AuctionDeployParams,
  encodeAuctionConfigData,
  uniformAuctionSteps,
} from "./auctionPlan.ts";
import {
  encodeFunctionData,
  selectorOf,
  ZERO_ADDRESS,
  type AbiType,
} from "./evmAbi.ts";
import { hashText } from "./work.ts";

const WAD = 10n ** 18n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** The auction library rejects a sale larger than 2^100 base units. */
const MAX_SALE_WEI = 1n << 100n;
const MAX_UINT96 = (1n << 96n) - 1n;
/** The lock holds at most this many milestones per team member. */
export const MAX_MILESTONES = 8;

export interface DaoLaunchSeat {
  /** The team member's wallet: they hold and vote with their Shares from the first block. */
  address: string;
  /** Share of the TEAM allocation, in whole percent. The seats add up to 100. */
  percent: number;
}

export interface DaoLaunchMilestone {
  check: string;
  percent: number;
}

export interface DaoLaunchInputs {
  name: string;
  symbol: string;
  /** Whole Shares in existence once the sale is done (18 decimals). */
  totalSupply: string;
  /** Whole percents of the supply; they add up to 100. */
  allocation: { sale: number; team: number; dao: number };
  /** Required when `allocation.team` is above zero. */
  team: DaoLaunchSeat[];
  /**
   * What holds the team's Shares back: each milestone is judged by reviewers against its `check` (the exact words of
   * its acceptance check) and unlocks `percent` of every team member's Shares. The founders hold and vote with all of
   * them from the first block; only the unlocked part can be sold or ragequit. They add up to at most 100; what they
   * leave out is never locked. Empty locks nothing.
   */
  milestones: DaoLaunchMilestone[];
  /** Whole Shares needed to open a proposal; "0" lets any holder. */
  proposalThreshold: string;
  /** Sale currency; null or "" is the chain's native currency. */
  currency: string | null;
  floorPrice: string;
  tickSpacing: string;
  requiredRaised: string;
  startBlock: number | null;
  endBlock: number | null;
  claimBlock: number | null;
  /** Mixes into every address the kit creates; derive it from the launch (see {@link launchSalt}). */
  salt: string;
}

/** A field-named planning failure: the form can point at exactly what to fix. */
export class DaoLaunchPlanError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "DaoLaunchPlanError";
    this.field = field;
  }
}

export interface DaoLaunchPlan {
  name: string;
  symbol: string;
  uri: string;
  proposalThreshold: bigint;
  salt: string;
  team: string[];
  teamShares: bigint[];
  /** keccak256 of each milestone's words, in order. */
  milestoneChecks: string[];
  /** The part of every team member's Shares each milestone unlocks, in basis points. */
  milestoneBps: number[];
  /** The words behind the hashes, for the receipt and the screen. */
  milestones: DaoLaunchMilestone[];
  daoShares: bigint;
  saleSupply: bigint;
  totalSupply: bigint;
  auction: AuctionDeployParams;
  /** `abi.encode(AuctionParameters)` once the executor address is known. */
  auctionSalt: string;
}

const fail = (field: string, message: string): never => {
  throw new DaoLaunchPlanError(field, message);
};

function wholeUnits(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) fail(field, `${field} must be a whole number.`);
  return BigInt(trimmed) * WAD;
}

function decimalField(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) fail(field, `${field} must be a whole number.`);
  return BigInt(trimmed);
}

function percent(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    fail(field, `${field} must be a whole percent from 0 to 100.`);
  }
  return value;
}

/** A launch's salt: stable across retries (so the addresses can be found again) and unique per launch. */
export function launchSalt(launchId: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(`creaton.launch:${launchId}`)))}`;
}

/**
 * Validate a launch and turn it into base units. Every rule the kit or the auction would enforce is checked
 * here first, so a bad plan fails before a wallet is asked for anything.
 */
export function planDaoLaunch(inputs: DaoLaunchInputs): DaoLaunchPlan {
  const name = inputs.name.trim();
  const symbol = inputs.symbol.trim();
  if (name === "") fail("name", "Give the project a name.");
  if (!/^[A-Za-z0-9]{2,8}$/.test(symbol)) {
    fail("symbol", "The ticker is 2 to 8 letters or digits.");
  }
  const total = wholeUnits(inputs.totalSupply, "totalSupply");
  if (total === 0n) fail("totalSupply", "There has to be at least one Share.");

  const sale = percent(inputs.allocation.sale, "sale share");
  const team = percent(inputs.allocation.team, "team share");
  const dao = percent(inputs.allocation.dao, "treasury share");
  if (sale + team + dao !== 100) {
    fail(
      "allocation",
      `The sale, team and treasury shares add up to ${sale + team + dao}%, not 100%.`,
    );
  }
  if (sale === 0) fail("sale share", "Sell at least some of the supply.");

  const saleSupply = (total * BigInt(sale)) / 100n;
  const teamTotal = (total * BigInt(team)) / 100n;
  const daoShares = total - saleSupply - teamTotal;
  if (saleSupply === 0n)
    fail("sale share", "The sale share is too small to sell.");
  if (saleSupply > MAX_SALE_WEI) {
    fail("sale share", "The sale is larger than the auction can hold.");
  }

  // Team seats: each gets their percent of the team allocation; the first takes the rounding remainder.
  const teamAddresses: string[] = [];
  const teamShares: bigint[] = [];
  if (teamTotal > 0n) {
    if (inputs.team.length === 0) {
      fail("team", "Name who holds the team allocation.");
    }
    if (inputs.team.length > 16)
      fail("team", "A launch has at most 16 team seats.");
    let seatPercent = 0;
    for (const seat of inputs.team) {
      if (!ADDRESS_RE.test(seat.address.trim())) {
        fail("team", `A team wallet is not an address: ${seat.address}`);
      }
      seatPercent += percent(seat.percent, "team seat");
      teamAddresses.push(seat.address.trim().toLowerCase());
      teamShares.push((teamTotal * BigInt(seat.percent)) / 100n);
    }
    if (seatPercent !== 100) {
      fail("team", `The team seats add up to ${seatPercent}%, not 100%.`);
    }
    teamShares[0] += teamTotal - teamShares.reduce((a, b) => a + b, 0n);
  }
  for (const wei of teamShares) {
    if (wei === 0n) fail("team", "A team seat is too small to hold a Share.");
  }

  const milestones = teamTotal > 0n ? inputs.milestones : [];
  if (milestones.length > MAX_MILESTONES) {
    fail("milestones", `A launch has at most ${MAX_MILESTONES} milestones.`);
  }
  const milestoneChecks: string[] = [];
  const milestoneBps: number[] = [];
  let milestonePercent = 0;
  for (const milestone of milestones) {
    const words = milestone.check.trim();
    if (words === "") {
      fail(
        "milestones",
        "Every milestone needs the words it will be judged by.",
      );
    }
    if (
      !Number.isInteger(milestone.percent) ||
      milestone.percent < 1 ||
      milestone.percent > 100
    ) {
      fail(
        "milestones",
        "Each milestone unlocks a whole percent from 1 to 100.",
      );
    }
    // The same hash a claim's check is stated with (`hashText`), so the milestone and its claim can meet.
    const hash = hashText(words);
    if (milestoneChecks.includes(hash)) {
      fail("milestones", `Two milestones are worded the same: ${words}`);
    }
    milestonePercent += milestone.percent;
    milestoneChecks.push(hash);
    milestoneBps.push(milestone.percent * 100);
  }
  if (milestonePercent > 100) {
    fail(
      "milestones",
      `The milestones unlock ${milestonePercent}% of the team's Shares, which is more than all of them.`,
    );
  }

  const threshold = wholeUnits(
    inputs.proposalThreshold || "0",
    "proposal threshold",
  );
  if (threshold > MAX_UINT96)
    fail("proposal threshold", "That threshold is too large.");

  const currencyInput = (inputs.currency ?? "").trim();
  if (currencyInput !== "" && !ADDRESS_RE.test(currencyInput)) {
    fail("currency", `The sale currency is not an address: ${inputs.currency}`);
  }
  const floorPrice = decimalField(inputs.floorPrice, "floor price");
  if (floorPrice < (1n << 32n) + 1n) {
    fail(
      "floor price",
      "The floor price is too low for the auction to price anything.",
    );
  }
  const tickSpacing = decimalField(inputs.tickSpacing, "tick spacing");
  if (tickSpacing < 2n)
    fail("tick spacing", "The tick spacing must be at least 2.");
  const requiredRaised = decimalField(inputs.requiredRaised, "raise target");
  if (requiredRaised === 0n)
    fail("raise target", "The raise target must be above zero.");
  if (requiredRaised > (1n << 128n) - 1n)
    fail("raise target", "That raise target is too large.");
  const blocks = [inputs.startBlock, inputs.endBlock, inputs.claimBlock];
  if (blocks.some((b) => b === null || !Number.isSafeInteger(b))) {
    fail("blocks", "The sale window is not set.");
  }
  const [startBlock, endBlock, claimBlock] = blocks as number[];
  if (startBlock <= 0 || endBlock <= startBlock || claimBlock <= endBlock) {
    fail(
      "blocks",
      "The sale has to start, then end, then open claims, in that order.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(inputs.salt)) {
    fail("salt", "The launch salt must be 32 bytes of hex.");
  }

  const auction: AuctionDeployParams = {
    token: ZERO_ADDRESS, // the DAO's Shares do not exist until the kit summons the DAO
    amount: saleSupply,
    currency: currencyInput === "" ? ZERO_ADDRESS : currencyInput.toLowerCase(),
    floorPrice,
    tickSpacing,
    requiredRaised,
    startBlock,
    endBlock,
    claimBlock,
    auctionStepsData: uniformAuctionSteps(startBlock, endBlock),
    treasury: ZERO_ADDRESS, // set at graduation: the kit points it at the DAO
    hookPerWalletCap: null,
  };
  return {
    name,
    symbol,
    uri: "",
    proposalThreshold: threshold,
    salt: inputs.salt.toLowerCase(),
    team: teamAddresses,
    teamShares,
    milestoneChecks,
    milestoneBps,
    milestones: milestones.map((m) => ({
      check: m.check.trim(),
      percent: m.percent,
    })),
    daoShares,
    saleSupply,
    totalSupply: total,
    auction,
    auctionSalt: inputs.salt.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

const PARAMS_TYPE: AbiType = {
  tuple: [
    "string", // name
    "string", // symbol
    "string", // uri
    "uint96", // proposalThreshold
    "bytes32", // salt
    { array: "address" }, // team
    { array: "uint256" }, // teamShares
    { array: "bytes32" }, // milestoneChecks
    { array: "uint16" }, // milestoneBps
    "uint256", // daoShares
    "uint128", // saleSupply
    "bytes", // auctionConfig
    "bytes32", // auctionSalt
  ],
};

/** `DaoLaunchKit.launch(Params)`, with the struct spelled out so the selector is the contract's. */
export const SIGNATURE_KIT_LAUNCH =
  "launch((string,string,string,uint96,bytes32,address[],uint256[],bytes32[],uint16[],uint256,uint128,bytes,bytes32))";
export const SIGNATURE_KIT_PREDICT_EXECUTOR =
  "predictExecutor(address,bytes32)";
export const SELECTOR_KIT_LAUNCH = selectorOf(SIGNATURE_KIT_LAUNCH);
export const SELECTOR_KIT_PREDICT_EXECUTOR = selectorOf(
  SIGNATURE_KIT_PREDICT_EXECUTOR,
);

/**
 * The read that tells the client where the executor will be, so the auction config can name it. The launching wallet
 * is part of the address: another wallet using the same salt gets different addresses.
 */
export function encodeKitPredictExecutor(
  launcher: string,
  salt: string,
): string {
  if (!ADDRESS_RE.test(launcher)) {
    throw new Error(`launcher address is invalid: ${launcher}`);
  }
  return encodeFunctionData(
    SIGNATURE_KIT_PREDICT_EXECUTOR,
    ["address", "bytes32"],
    [launcher, salt],
  );
}

/** The one transaction. `executor` is the kit's `predictExecutor(launcher, salt)` answer. */
export function encodeKitLaunch(plan: DaoLaunchPlan, executor: string): string {
  if (!ADDRESS_RE.test(executor))
    throw new Error(`executor address is invalid: ${executor}`);
  const auctionConfig = encodeAuctionConfigData({
    params: plan.auction,
    executor,
    hook: null,
  });
  return encodeFunctionData(
    SIGNATURE_KIT_LAUNCH,
    [PARAMS_TYPE],
    [
      [
        plan.name,
        plan.symbol,
        plan.uri,
        plan.proposalThreshold,
        plan.salt,
        plan.team,
        plan.teamShares,
        plan.milestoneChecks,
        plan.milestoneBps.map(BigInt),
        plan.daoShares,
        plan.saleSupply,
        auctionConfig,
        plan.auctionSalt,
      ],
    ],
  );
}

// ---------------------------------------------------------------------------
// The Launched event
// ---------------------------------------------------------------------------

/** `Launched(address,address,address,address,address,address,uint128)`. */
export const TOPIC_KIT_LAUNCHED = `0x${bytesToHex(
  keccak_256(
    utf8ToBytes(
      "Launched(address,address,address,address,address,address,uint128)",
    ),
  ),
)}`;

export interface KitLaunched {
  dao: string;
  launcher: string;
  shares: string;
  executor: string;
  auction: string;
  /** The milestone lock holding the team's Shares, or null when the launch locked nothing. */
  lock: string | null;
  saleSupply: bigint;
}

interface LogLike {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
}

const wordAddress = (hex: string): string => `0x${hex.slice(24)}`.toLowerCase();

/**
 * Read the kit's `Launched` event out of a receipt's logs. Only a log emitted BY the kit counts: any contract can
 * emit an event with this topic, and a launch must not be recorded from one that is not ours.
 */
export function decodeKitLaunched(
  logs: readonly unknown[],
  kit: string,
): KitLaunched | null {
  for (const entry of logs) {
    if (entry === null || typeof entry !== "object") continue;
    const log = entry as LogLike;
    const topics = Array.isArray(log.topics) ? (log.topics as unknown[]) : [];
    if (
      typeof log.address !== "string" ||
      log.address.toLowerCase() !== kit.toLowerCase() ||
      topics[0] !== TOPIC_KIT_LAUNCHED ||
      topics.length !== 3 ||
      typeof topics[1] !== "string" ||
      typeof topics[2] !== "string" ||
      typeof log.data !== "string"
    ) {
      continue;
    }
    const data = log.data.replace(/^0x/, "");
    if (data.length !== 64 * 5) continue;
    const w = (i: number) => data.slice(i * 64, (i + 1) * 64);
    const lock = wordAddress(w(3));
    return {
      dao: wordAddress((topics[1] as string).replace(/^0x/, "")),
      launcher: wordAddress((topics[2] as string).replace(/^0x/, "")),
      shares: wordAddress(w(0)),
      executor: wordAddress(w(1)),
      auction: wordAddress(w(2)),
      lock: BigInt(lock) === 0n ? null : lock,
      saleSupply: BigInt(`0x${w(4)}`),
    };
  }
  return null;
}

/** What each part of the supply means to a person, for the launch screen. */
export function describeDaoLaunch(plan: DaoLaunchPlan): {
  sale: bigint;
  team: bigint;
  treasury: bigint;
  total: bigint;
  /**
   * The part of the treasury backers can leave with if the whole sale sells and all of them leave, in basis points.
   * The DAO's own Shares do not count, so it is the sale against the sale plus the team: the team's Shares are
   * outstanding (locked, but theirs) and share the treasury with the backers once they unlock.
   */
  backersExitBps: number;
  /** The part of the team's allocation held back until a milestone is reached, in basis points (0 when none is). */
  teamLockedBps: number;
} {
  const team = plan.teamShares.reduce((a, b) => a + b, 0n);
  const outstanding = plan.saleSupply + team;
  return {
    sale: plan.saleSupply,
    team,
    treasury: plan.daoShares,
    total: plan.totalSupply,
    backersExitBps: Number((plan.saleSupply * 10_000n) / outstanding),
    teamLockedBps: plan.milestoneBps.reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------------------
// From a launch record, and what the screen says before anything is sent
// ---------------------------------------------------------------------------

/** The fields of a launch record a DAO launch reads (structural, so web and desktop both fit). */
export interface DaoLaunchRecordLike {
  id: string;
  author: string;
  chainId: string | null;
  tokenPlan: {
    mode: string;
    name: string;
    symbol: string;
    supply: string;
  } | null;
  allocation: {
    sale: number;
    team: number;
    treasury: number;
    liquidity: number;
    milestones: number;
    community: number;
  };
  currency: string | null;
  floorPrice: string | null;
  tickSpacing: string | null;
  requiredRaised: string | null;
  startBlock: number | null;
  endBlock: number | null;
  claimBlock: number | null;
  /** What the project's own allocation releases against (the wizard's unlock plan). */
  unlocks: {
    mode: string;
    milestones: { label: string; percent: number }[];
  } | null;
}

/**
 * A record's launch inputs. The record stores the SALE tranche (`tokenPlan.supply`) and a percentage split, so the
 * total is the tranche over its share. The team allocation goes to the founder's wallet and votes from the first
 * block, held back by the unlock plan's milestones (the words of each milestone are what its reviewers judge it by);
 * the treasury, liquidity, milestone and community parts are the DAO's own from the start.
 */
export function daoLaunchInputsFromRecord(
  record: DaoLaunchRecordLike,
  founder: string,
  options: { proposalThreshold?: string } = {},
): DaoLaunchInputs {
  const plan = record.tokenPlan;
  if (plan?.mode !== "dao") {
    return fail(
      "tokenPlan",
      "This launch is not set up to sell the project's own Shares.",
    );
  }
  const sale = record.allocation.sale;
  const tranche = decimalField(plan.supply, "sale supply");
  if (!Number.isInteger(sale) || sale <= 0) {
    fail("sale share", "Set how much of the supply is sold.");
  }
  if ((tranche * 100n) % BigInt(sale) !== 0n) {
    fail(
      "sale supply",
      `${plan.supply} tokens is not exactly ${sale}% of any whole supply. Adjust the sale share or the supply.`,
    );
  }
  const total = (tranche * 100n) / BigInt(sale);
  const { team, treasury, liquidity, milestones, community } =
    record.allocation;
  // The team's Shares unlock by milestones in a DAO launch: not by time. A record that never said locks nothing.
  const unlocks = record.unlocks;
  if (team > 0 && unlocks?.mode === "time") {
    fail(
      "unlocks",
      "A launch into its own DAO unlocks the team's Shares by milestones, not by time. Choose milestones, or no lock.",
    );
  }
  const lockMilestones =
    team > 0 && unlocks?.mode === "milestones"
      ? unlocks.milestones.map((m) => ({ check: m.label, percent: m.percent }))
      : [];
  const threshold =
    options.proposalThreshold ??
    (total / 100n > 0n ? (total / 100n).toString() : "1");
  return {
    name: plan.name,
    symbol: plan.symbol,
    totalSupply: total.toString(),
    allocation: {
      sale,
      team,
      dao: treasury + liquidity + milestones + community,
    },
    team: team > 0 ? [{ address: founder, percent: 100 }] : [],
    milestones: lockMilestones,
    proposalThreshold: threshold,
    currency: record.currency,
    floorPrice: record.floorPrice ?? "",
    tickSpacing: record.tickSpacing ?? "",
    requiredRaised: record.requiredRaised ?? "",
    startBlock: record.startBlock,
    endBlock: record.endBlock,
    claimBlock: record.claimBlock,
    salt: launchSalt(`${record.author}:${record.id}`),
  };
}

export type DaoLaunchGate =
  | { ok: true }
  | {
      ok: false;
      reason: "mainnet" | "no-kit" | "plan" | "no-wallet" | "wrong-chain";
      message: string;
    };

/** Why the launch cannot be sent yet, in the order a founder can fix things: build, chain, terms, wallet. */
export function daoLaunchGate(input: {
  mainnetBlocked: boolean;
  /** The launch contract on this chain, or null when the build names none. */
  kit: string | null;
  planProblem: string | null;
  address: string | null;
  walletChainId: number | null;
  launchChainId: number | null;
}): DaoLaunchGate {
  if (input.mainnetBlocked) {
    return {
      ok: false,
      reason: "mainnet",
      message:
        "This launch is on a mainnet, and this build has mainnet switched off. The contracts are unaudited: use a test network.",
    };
  }
  if (!input.kit) {
    return {
      ok: false,
      reason: "no-kit",
      message:
        "Launching a project with its own DAO is not set up for this network yet: the launch contract has not been deployed here.",
    };
  }
  if (input.planProblem) {
    return { ok: false, reason: "plan", message: input.planProblem };
  }
  if (!input.address) {
    return {
      ok: false,
      reason: "no-wallet",
      message:
        "Connect your wallet to launch. It is the wallet that holds your team allocation.",
    };
  }
  if (
    input.launchChainId !== null &&
    input.walletChainId !== null &&
    input.walletChainId !== input.launchChainId
  ) {
    return {
      ok: false,
      reason: "wrong-chain",
      message: `Your wallet is on chain ${input.walletChainId}, but this launch is on chain ${input.launchChainId}. Switch networks in your wallet.`,
    };
  }
  return { ok: true };
}

/**
 * The `dao-launch` receipt: the governance screens read `dao` from it to find the DAO. It is not a `summon` receipt,
 * which would mark the launch graduated before the raise has happened.
 */
export function daoLaunchReceiptContent(input: {
  launched: KitLaunched;
  plan: DaoLaunchPlan;
  chainId: string;
  kit: string;
}): Record<string, unknown> {
  const { launched, plan } = input;
  return {
    table: "dao-launch",
    dao: launched.dao,
    chain: input.chainId,
    launchKit: input.kit.toLowerCase(),
    shares: launched.shares,
    executor: launched.executor,
    auction: launched.auction,
    lock: launched.lock,
    totalShares: plan.totalSupply.toString(),
    saleShares: plan.saleSupply.toString(),
    teamShares: plan.teamShares.map(String),
    daoShares: plan.daoShares.toString(),
    team: plan.team,
    milestones: plan.milestones,
    ragequittable: true,
  };
}
