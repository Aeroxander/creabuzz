/**
 * Launching a project into a DAO it does not control, in one transaction (`contracts/src/DaoLaunchKit.sol`).
 *
 * The old launch sold a token the founder minted and paid the raise to a wallet the founder chose. This path sells
 * the DAO's own Shares, vests the team's allocation, and settles the raise into the DAO, all in one atomic call, so
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

const WAD = 10n ** 18n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** The auction library rejects a sale larger than 2^100 base units. */
const MAX_SALE_WEI = 1n << 100n;
const MAX_UINT96 = (1n << 96n) - 1n;
const DAY = 86_400;

export interface DaoLaunchSeat {
  /** The team member's wallet: the address the vesting vault releases to. */
  address: string;
  /** Share of the TEAM allocation, in whole percent. The seats add up to 100. */
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
  /** The team's allocation unlocks linearly after the cliff. */
  vesting: { cliffDays: number; durationDays: number };
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
  vestCliff: bigint;
  vestDuration: bigint;
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
      fail("team", "Name who the team allocation vests to.");
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

  const { cliffDays, durationDays } = inputs.vesting;
  if (!Number.isInteger(cliffDays) || !Number.isInteger(durationDays)) {
    fail("vesting", "Vesting is set in whole days.");
  }
  if (
    teamTotal > 0n &&
    (durationDays <= 0 || cliffDays < 0 || cliffDays > durationDays)
  ) {
    fail("vesting", "Vesting needs a duration, and a cliff no longer than it.");
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
    vestCliff: BigInt(cliffDays * DAY),
    vestDuration: BigInt(durationDays * DAY),
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
    "uint64", // vestCliff
    "uint64", // vestDuration
    "uint256", // daoShares
    "uint128", // saleSupply
    "bytes", // auctionConfig
    "bytes32", // auctionSalt
  ],
};

/** `DaoLaunchKit.launch(Params)`, with the struct spelled out so the selector is the contract's. */
export const SIGNATURE_KIT_LAUNCH =
  "launch((string,string,string,uint96,bytes32,address[],uint256[],uint64,uint64,uint256,uint128,bytes,bytes32))";
export const SIGNATURE_KIT_PREDICT_EXECUTOR = "predictExecutor(bytes32)";
export const SELECTOR_KIT_LAUNCH = selectorOf(SIGNATURE_KIT_LAUNCH);
export const SELECTOR_KIT_PREDICT_EXECUTOR = selectorOf(
  SIGNATURE_KIT_PREDICT_EXECUTOR,
);

/** The read that tells the client where the executor will be, so the auction config can name it. */
export function encodeKitPredictExecutor(salt: string): string {
  return encodeFunctionData(
    SIGNATURE_KIT_PREDICT_EXECUTOR,
    ["bytes32"],
    [salt],
  );
}

/** The one transaction. `executor` is the kit's `predictExecutor(salt)` answer. */
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
        plan.vestCliff,
        plan.vestDuration,
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

/** `Launched(address,address,address,address,address,address[],uint128)`. */
export const TOPIC_KIT_LAUNCHED = `0x${bytesToHex(
  keccak_256(
    utf8ToBytes(
      "Launched(address,address,address,address,address,address[],uint128)",
    ),
  ),
)}`;

export interface KitLaunched {
  dao: string;
  launcher: string;
  shares: string;
  executor: string;
  auction: string;
  vaults: string[];
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
    if (data.length < 64 * 6 || data.length % 64 !== 0) continue;
    const w = (i: number) => data.slice(i * 64, (i + 1) * 64);
    const offset = Number(BigInt(`0x${w(3)}`)) / 32;
    if (
      !Number.isInteger(offset) ||
      offset < 5 ||
      data.length < (offset + 1) * 64
    )
      continue;
    const count = Number(BigInt(`0x${w(offset)}`));
    if (
      !Number.isSafeInteger(count) ||
      count > 64 ||
      data.length < (offset + 1 + count) * 64
    )
      continue;
    return {
      dao: wordAddress((topics[1] as string).replace(/^0x/, "")),
      launcher: wordAddress((topics[2] as string).replace(/^0x/, "")),
      shares: wordAddress(w(0)),
      executor: wordAddress(w(1)),
      auction: wordAddress(w(2)),
      vaults: Array.from({ length: count }, (_, i) =>
        wordAddress(w(offset + 1 + i)),
      ),
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
} {
  return {
    sale: plan.saleSupply,
    team: plan.teamShares.reduce((a, b) => a + b, 0n),
    treasury: plan.daoShares,
    total: plan.totalSupply,
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
}

/** Vesting the team allocation starts from: a six-month cliff, then linear over four years. */
export const DEFAULT_TEAM_VESTING = {
  cliffDays: 180,
  durationDays: 1460,
} as const;

/**
 * A record's launch inputs. The record stores the SALE tranche (`tokenPlan.supply`) and a percentage split, so the
 * total is the tranche over its share; the team allocation vests to the founder's wallet, and the treasury,
 * liquidity, milestone and community parts are the DAO's own from the start.
 */
export function daoLaunchInputsFromRecord(
  record: DaoLaunchRecordLike,
  founder: string,
  options: {
    cliffDays?: number;
    durationDays?: number;
    proposalThreshold?: string;
  } = {},
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
    vesting: {
      cliffDays: options.cliffDays ?? DEFAULT_TEAM_VESTING.cliffDays,
      durationDays: options.durationDays ?? DEFAULT_TEAM_VESTING.durationDays,
    },
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
        "Connect your wallet to launch. It is the wallet your team allocation vests to.",
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
    vaults: launched.vaults,
    totalShares: plan.totalSupply.toString(),
    saleShares: plan.saleSupply.toString(),
    teamShares: plan.teamShares.map(String),
    daoShares: plan.daoShares.toString(),
    team: plan.team,
    vestCliffSeconds: plan.vestCliff.toString(),
    vestDurationSeconds: plan.vestDuration.toString(),
    ragequittable: true,
  };
}
