/**
 * The backing pool (docs/v3-review/BACKING-POOL.md, `contracts/src/BackingPool.sol`, `BackingPoolFactory.sol`): the app's
 * only adapter for it. Each project can have one pool; backers buy and sell its units on a curve, a tenth of each buy is
 * held for the project and released at milestones, and an optional opening round is a Uniswap auction.
 *
 * This module holds what is true of the contracts and nothing of the page: the signatures (each pinned to `cast sig` in
 * `backing.test.mjs`), the calldata builders, strict decoders for the two read structs (`snapshot`, `roundInfo`), the
 * events, the contracts' custom errors, the fixed-point rules for prices and amounts, and the one rule that says where a
 * pool stands. The chain is injected, so the same tests run the real reader against a fake one.
 *
 * Fixed point, as the contracts state it:
 *   - a curve price is quote base units per WHOLE unit (1e18 base units), times 1e18 (`price()`, `buyPrice()`,
 *     `priceAfter`), whatever the quote token's decimals are;
 *   - a round price is the auction's own: quote base units per base unit of claim token, times 2^96 (`clearingPriceX96`).
 * Nothing here scales an amount by an assumed decimals: the quote token's own `decimals()` is always passed in.
 *
 * Pure apart from the reader, whose chain is injected.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  type AbiType,
  decodeParameters,
  encodeFunctionData,
  selectorOf,
} from "./evmAbi.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = (1n << 256n) - 1n;

const Q96 = 1n << 96n;

// ---- signatures ----------------------------------------------------------------------------------

/** Every function of the pool, its factory and the claim token this app reads or sends. */
export const BACKING_SIGNATURES = {
  // factory
  poolOf: "poolOf(address)",
  open: "open(address)",
  openWithRound: "openWithRound(address,uint128)",
  factoryQuote: "quote()",
  defaultMinimumRaise: "defaultMinimumRaise()",
  roundFloorPriceX96: "roundFloorPriceX96()",
  roundTickSpacingX96: "roundTickSpacingX96()",
  roundBlocks: "roundBlocks()",
  founderOf: "founderOf(address)",
  auctionFactory: "auctionFactory()",
  // pool, reads
  snapshot: "snapshot(address)",
  roundInfo: "roundInfo(address)",
  quoteBuy: "quoteBuy(uint256)",
  quoteSell: "quoteSell(address,uint256)",
  quoteLeave: "quoteLeave(address)",
  founder: "founder()",
  dao: "dao()",
  quote: "quote()",
  // pool, steps
  buy: "buy(uint256,uint256,uint256)",
  sell: "sell(uint256,uint256,uint256)",
  leave: "leave(uint256,uint256)",
  postMilestone: "postMilestone(bytes32)",
  resolveMilestone: "resolveMilestone()",
  seedFromAuction: "seedFromAuction()",
  redeem: "redeem(uint256)",
  voteAbandon: "voteAbandon()",
  declareAbandoned: "declareAbandoned()",
  payTreasury: "payTreasury()",
} as const;

// ---- structs -------------------------------------------------------------------------------------

const MILESTONE_TYPE: AbiType = {
  tuple: [
    "bytes32", // ref
    "uint64", // postedAt
    "uint64", // windowEndsAt
    "uint64", // resolveBy
    "uint8", // status
    "uint256", // escrowAtPost
    "uint256", // leftWith
    "uint256", // released
  ],
};

const ROUND_VIEW_TYPE: AbiType = {
  tuple: [
    "uint8", // state
    "address", // auction
    "address", // claimToken
    "uint256", // supply
    "uint64", // endBlock
    "uint256", // minimumRaise
    "uint256", // raised
    "uint256", // clearingPriceX96
    "uint256", // received
    "uint256", // unitsSold
    "uint256", // openingPrice
    "uint64", // liveAt
    "uint256", // unredeemedUnits
    "uint256", // holderClaimTokens
  ],
};

const SNAPSHOT_TYPE: AbiType = {
  tuple: [
    "uint256", // price
    "uint256", // buyPrice
    "uint256", // reserve
    "uint256", // escrow
    "uint256", // released
    "uint256", // refunded
    "uint256", // feesTaken
    "uint256", // treasuryOwed
    "uint256", // totalSupply
    "uint256", // totalWeight
    "bool", // abandoned
    "uint64", // openedAt
    "uint64", // nextClaimAt
    "uint64", // abandonableAt
    "uint256", // abandonVotes
    "uint256", // milestoneId
    MILESTONE_TYPE,
    "uint256", // pending
    "uint256", // holderUnits
    "uint256", // holderWeight
    "uint256", // holderEscrow
    "uint256", // holderSellValue
    "bool", // holderCanLeave
    "uint256", // holderLeaveValue
    "bool", // holderVotedAbandon
    "uint256", // holderEarlyLeft
    ROUND_VIEW_TYPE,
  ],
};

/** The three structs as ABI types, exported so a test can bind them to the Solidity source field for field. */
export const BACKING_STRUCT_TYPES = {
  Milestone: MILESTONE_TYPE,
  RoundView: ROUND_VIEW_TYPE,
  Snapshot: SNAPSHOT_TYPE,
} as const;

/** Where a milestone post stands (`BackingPool.MilestoneStatus`). */
type MilestoneStatus = "none" | "open" | "released" | "void";
const MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  "none",
  "open",
  "released",
  "void",
];

/** Where a pool's opening round stands (`BackingPool.RoundState`). `none`: the pool was opened without one. */
type RoundState = "none" | "waiting" | "live" | "failed";
const ROUND_STATES: readonly RoundState[] = [
  "none",
  "waiting",
  "live",
  "failed",
];

interface MilestoneView {
  /** The id of the public record event the founder named. */
  ref: string;
  postedAt: number;
  /** Until when backers may leave. */
  windowEndsAt: number;
  /** Until when it can be released; after that it can only be cancelled. */
  resolveBy: number;
  status: MilestoneStatus;
  escrowAtPost: bigint;
  leftWith: bigint;
  released: bigint;
}

export interface RoundView {
  state: RoundState;
  auction: string;
  claimToken: string;
  supply: bigint;
  /** The round takes bids until this block, on the auction's own clock. */
  endBlock: number;
  minimumRaise: bigint;
  raised: bigint;
  clearingPriceX96: bigint;
  received: bigint;
  unitsSold: bigint;
  openingPrice: bigint;
  liveAt: number;
  unredeemedUnits: bigint;
  /** Claim tokens the wallet holds: what it can exchange for units once the pool is live. */
  holderClaimTokens: bigint;
}

export interface PoolSnapshot {
  price: bigint;
  buyPrice: bigint;
  reserve: bigint;
  /** What is held for the project: not yet released, not yet handed back. */
  escrow: bigint;
  released: bigint;
  refunded: bigint;
  feesTaken: bigint;
  treasuryOwed: bigint;
  totalSupply: bigint;
  totalWeight: bigint;
  abandoned: boolean;
  openedAt: number;
  nextClaimAt: number;
  abandonableAt: number;
  abandonVotes: bigint;
  milestoneId: bigint;
  milestone: MilestoneView;
  pending: bigint;
  holderUnits: bigint;
  holderWeight: bigint;
  /** The wallet's own part of what is held for the project. */
  holderEscrow: bigint;
  /** What selling all the wallet's units would pay now. */
  holderSellValue: bigint;
  holderCanLeave: boolean;
  /** What leaving at the open milestone would pay now. */
  holderLeaveValue: bigint;
  holderVotedAbandon: boolean;
  /** What the wallet may still put in under the early limit; `null` when there is no limit now. */
  holderEarlyLeft: bigint | null;
  round: RoundView;
}

function asNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${what} is too large to be a time or a block`);
  }
  return Number(value);
}

function oneOf<T>(list: readonly T[], index: bigint, what: string): T {
  const found = list[Number(index)];
  if (index >= BigInt(list.length) || found === undefined) {
    throw new Error(`${what} answered a state this app does not know`);
  }
  return found;
}

type Tuple = readonly (bigint | boolean | string | readonly unknown[])[];

function decodeMilestone(t: Tuple): MilestoneView {
  return {
    ref: t[0] as string,
    postedAt: asNumber(t[1] as bigint, "milestone.postedAt"),
    windowEndsAt: asNumber(t[2] as bigint, "milestone.windowEndsAt"),
    resolveBy: asNumber(t[3] as bigint, "milestone.resolveBy"),
    status: oneOf(MILESTONE_STATUSES, t[4] as bigint, "milestone.status"),
    escrowAtPost: t[5] as bigint,
    leftWith: t[6] as bigint,
    released: t[7] as bigint,
  };
}

function decodeRoundTuple(t: Tuple): RoundView {
  return {
    state: oneOf(ROUND_STATES, t[0] as bigint, "round.state"),
    auction: t[1] as string,
    claimToken: t[2] as string,
    supply: t[3] as bigint,
    endBlock: asNumber(t[4] as bigint, "round.endBlock"),
    minimumRaise: t[5] as bigint,
    raised: t[6] as bigint,
    clearingPriceX96: t[7] as bigint,
    received: t[8] as bigint,
    unitsSold: t[9] as bigint,
    openingPrice: t[10] as bigint,
    liveAt: asNumber(t[11] as bigint, "round.liveAt"),
    unredeemedUnits: t[12] as bigint,
    holderClaimTokens: t[13] as bigint,
  };
}

/**
 * `snapshot(address)`'s answer: the whole struct is static, so it is its 47 words one after the other. A short, empty or
 * oversized answer, or a field that does not fit its width, is a read we do not have: it throws, and nothing is shaped
 * into a plausible default (Review-Proven Rule 1).
 */
export function decodeSnapshot(hex: string): PoolSnapshot {
  const body = typeof hex === "string" ? hex.replace(/^0x/, "") : "";
  if (body.length !== 47 * 64) {
    throw new Error(
      `snapshot() answered ${body.length} characters of hex, not 47 32-byte words`,
    );
  }
  const [t] = decodeParameters([SNAPSHOT_TYPE], hex) as [Tuple];
  const early = t[25] as bigint;
  return {
    price: t[0] as bigint,
    buyPrice: t[1] as bigint,
    reserve: t[2] as bigint,
    escrow: t[3] as bigint,
    released: t[4] as bigint,
    refunded: t[5] as bigint,
    feesTaken: t[6] as bigint,
    treasuryOwed: t[7] as bigint,
    totalSupply: t[8] as bigint,
    totalWeight: t[9] as bigint,
    abandoned: t[10] as boolean,
    openedAt: asNumber(t[11] as bigint, "openedAt"),
    nextClaimAt: asNumber(t[12] as bigint, "nextClaimAt"),
    abandonableAt: asNumber(t[13] as bigint, "abandonableAt"),
    abandonVotes: t[14] as bigint,
    milestoneId: t[15] as bigint,
    milestone: decodeMilestone(t[16] as Tuple),
    pending: t[17] as bigint,
    holderUnits: t[18] as bigint,
    holderWeight: t[19] as bigint,
    holderEscrow: t[20] as bigint,
    holderSellValue: t[21] as bigint,
    holderCanLeave: t[22] as boolean,
    holderLeaveValue: t[23] as bigint,
    holderVotedAbandon: t[24] as boolean,
    // The contract answers "no limit now" with the largest number there is.
    holderEarlyLeft: early === MAX_UINT256 ? null : early,
    round: decodeRoundTuple(t[26] as Tuple),
  };
}

/** `roundInfo(address)`'s answer (14 static words). */
export function decodeRoundInfo(hex: string): RoundView {
  const body = typeof hex === "string" ? hex.replace(/^0x/, "") : "";
  if (body.length !== 14 * 64) {
    throw new Error(
      `roundInfo() answered ${body.length} characters of hex, not 14 32-byte words`,
    );
  }
  const [t] = decodeParameters([ROUND_VIEW_TYPE], hex) as [Tuple];
  return decodeRoundTuple(t);
}

// ---- quotes --------------------------------------------------------------------------------------

export interface BuyQuote {
  unitsOut: bigint;
  fee: bigint;
  toEscrow: bigint;
  priceAfter: bigint;
}
export interface SellQuote {
  quoteOut: bigint;
  fee: bigint;
  /** The wallet's part of what is held for the project, paid with the sale: only after abandonment. */
  refund: bigint;
  priceAfter: bigint;
}
export interface LeaveQuote {
  quoteOut: bigint;
  fromCurve: bigint;
  fromEscrow: bigint;
  priceAfter: bigint;
  fee: bigint;
}

function words(hex: string, expected: number, what: string): bigint[] {
  const body = typeof hex === "string" ? hex.replace(/^0x/, "") : "";
  if (body.length !== expected * 64 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(
      `${what} answered ${body.length} characters of hex, not ${expected} 32-byte words`,
    );
  }
  const out: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) {
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return out;
}

function decodeBuyQuote(hex: string): BuyQuote {
  const w = words(hex, 4, "quoteBuy()");
  return { unitsOut: w[0], fee: w[1], toEscrow: w[2], priceAfter: w[3] };
}
function decodeSellQuote(hex: string): SellQuote {
  const w = words(hex, 4, "quoteSell()");
  return { quoteOut: w[0], fee: w[1], refund: w[2], priceAfter: w[3] };
}
function decodeLeaveQuote(hex: string): LeaveQuote {
  const w = words(hex, 5, "quoteLeave()");
  return {
    quoteOut: w[0],
    fromCurve: w[1],
    fromEscrow: w[2],
    priceAfter: w[3],
    fee: w[4],
  };
}

// ---- calls ---------------------------------------------------------------------------------------

function address(value: string, what: string): string {
  const trimmed = (value ?? "").trim();
  if (!ADDRESS_RE.test(trimmed)) throw new Error(`${what} is not an address`);
  return trimmed.toLowerCase();
}

function uint(value: bigint, bits: number, what: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits)) {
    throw new Error(`${what} does not fit in ${bits} bits`);
  }
  return value;
}

/** Calldata with no arguments. */
function encodeNoArgs(signature: string): string {
  return selectorOf(signature);
}

export const encodePoolOf = (dao: string): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.poolOf,
    ["address"],
    [address(dao, "The project's DAO")],
  );
export const encodeSnapshot = (holder: string): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.snapshot,
    ["address"],
    [address(holder, "The holder")],
  );
const encodeQuoteBuy = (quoteIn: bigint): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.quoteBuy,
    ["uint256"],
    [uint(quoteIn, 256, "The amount")],
  );
const encodeQuoteSell = (holder: string, unitsIn: bigint): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.quoteSell,
    ["address", "uint256"],
    [address(holder, "The holder"), uint(unitsIn, 256, "The units")],
  );
const encodeFounderOf = (dao: string): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.founderOf,
    ["address"],
    [address(dao, "The project's DAO")],
  );
const encodeQuoteLeave = (holder: string): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.quoteLeave,
    ["address"],
    [address(holder, "The holder")],
  );

/** Buy with exactly `quoteIn`; approve the pool for it first. The limit and the deadline are never optional. */
export function encodeBuy(
  quoteIn: bigint,
  minUnitsOut: bigint,
  deadline: bigint,
): string {
  if (quoteIn <= 0n) throw new Error("Put in an amount above zero");
  return encodeFunctionData(
    BACKING_SIGNATURES.buy,
    ["uint256", "uint256", "uint256"],
    [
      uint(quoteIn, 256, "The amount"),
      uint(minUnitsOut, 256, "The fewest units"),
      uint(deadline, 256, "The deadline"),
    ],
  );
}

export function encodeSell(
  unitsIn: bigint,
  minQuoteOut: bigint,
  deadline: bigint,
): string {
  if (unitsIn <= 0n) throw new Error("Sell an amount above zero");
  return encodeFunctionData(
    BACKING_SIGNATURES.sell,
    ["uint256", "uint256", "uint256"],
    [
      uint(unitsIn, 256, "The units"),
      uint(minQuoteOut, 256, "The least money"),
      uint(deadline, 256, "The deadline"),
    ],
  );
}

export function encodeLeave(minQuoteOut: bigint, deadline: bigint): string {
  return encodeFunctionData(
    BACKING_SIGNATURES.leave,
    ["uint256", "uint256"],
    [
      uint(minQuoteOut, 256, "The least money"),
      uint(deadline, 256, "The deadline"),
    ],
  );
}

/** A public record event's id (64 hex characters) as the milestone's reference. Zero is refused by the pool. */
export function recordRef(eventId: string): string {
  const id = (eventId ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(id) || /^0+$/.test(id)) {
    throw new Error("A milestone names one public record by its ID");
  }
  return `0x${id}`;
}

export function encodePostMilestone(eventId: string): string {
  return encodeFunctionData(
    BACKING_SIGNATURES.postMilestone,
    ["bytes32"],
    [recordRef(eventId)],
  );
}
export const encodeResolveMilestone = (): string =>
  encodeNoArgs(BACKING_SIGNATURES.resolveMilestone);
export const encodeSeedFromAuction = (): string =>
  encodeNoArgs(BACKING_SIGNATURES.seedFromAuction);
export const encodeRedeem = (amount: bigint): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.redeem,
    ["uint256"],
    [uint(amount, 256, "The amount")],
  );

/** `BackingPoolFactory.open(dao)`: the pool opens now, no round. */
export const encodeOpenPool = (dao: string): string =>
  encodeFunctionData(
    BACKING_SIGNATURES.open,
    ["address"],
    [address(dao, "The project's DAO")],
  );

/** `BackingPoolFactory.openWithRound(dao, minimumRaise)`: a fair opening round first. Zero asks for the default minimum. */
export function encodeOpenWithRound(dao: string, minimumRaise: bigint): string {
  return encodeFunctionData(
    BACKING_SIGNATURES.openWithRound,
    ["address", "uint128"],
    [address(dao, "The project's DAO"), uint(minimumRaise, 128, "The minimum")],
  );
}

// ---- amounts and prices --------------------------------------------------------------------------

/** `parseAmount("12.5", 6)` is `12500000n`. Null when the text is not a plain decimal with at most `decimals` places. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const clean = (text ?? "").replace(/[,_\s]/g, "");
  const m = /^(\d+)(?:\.(\d*))?$/.exec(clean);
  if (!m) return null;
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) return null;
  return (
    BigInt(m[1]) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The exact decimal text of `value` at `decimals`, without grouping or trailing zeros. */
export function exactDecimal(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return `${sign}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

/**
 * An amount for people: thousands grouped, two places when it is a few units or more, and enough places to show four
 * significant digits when it is smaller. Never rounds a non-zero amount to zero: it says "less than 0.000001" instead.
 * Money is cut, not rounded up, so a figure never promises more than there is; a price, which has no such risk and comes
 * out of a fixed point that is itself cut, is rounded to the nearest (`rounding: "nearest"`).
 */
export function formatAmount(
  value: bigint,
  decimals: number,
  rounding: "down" | "nearest" = "down",
): string {
  if (value === 0n) return "0";
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const shown = rounding === "nearest" ? roundedUp(abs, decimals) : abs;
  const exact = exactDecimal(shown, decimals);
  const [whole, fraction = ""] = exact.split(".");
  if (whole !== "0") {
    const cut = fraction.slice(0, 2).replace(/0+$/, "");
    return `${sign}${groupThousands(whole)}${cut ? `.${cut}` : ""}`;
  }
  // Below one: keep the first four significant digits.
  const lead = fraction.match(/^0*/)?.[0].length ?? 0;
  if (lead > 6) return `${sign}less than 0.000001`;
  const cut = fraction.slice(0, lead + 4).replace(/0+$/, "");
  return `${sign}0.${cut}`;
}

/** `abs` with half of the last place `formatAmount` shows added, so cutting it afterwards rounds to the nearest. */
function roundedUp(abs: bigint, decimals: number): bigint {
  const exact = exactDecimal(abs, decimals);
  const [whole, fraction = ""] = exact.split(".");
  const places =
    whole !== "0" ? 2 : (fraction.match(/^0*/)?.[0].length ?? 0) + 4;
  if (places >= decimals) return abs;
  return abs + 10n ** BigInt(decimals - places) / 2n;
}

/** A curve price in whole quote tokens per whole unit, from the contract's fixed point (see the file's header). */
export function formatCurvePrice(price: bigint, quoteDecimals: number): string {
  return formatAmount(price, 18 + quoteDecimals, "nearest");
}

/**
 * A round's clearing price in whole quote tokens per whole claim token: the auction's price is quote base units per base
 * unit of claim token times 2^96, and claim tokens have 18 decimals like units do.
 */
function roundPriceDecimals(
  priceX96: bigint,
  quoteDecimals: number,
): { value: bigint; decimals: number } {
  // price = (x96 / 2^96) quote base per claim base, times 10^18 claim base per whole claim token, over 10^quoteDecimals.
  // Carrying 18 more places keeps a price of a few millionths exact for a 6-decimal quote.
  return {
    value: (priceX96 * 10n ** 36n) / Q96,
    decimals: quoteDecimals + 18,
  };
}
export function formatRoundPrice(
  priceX96: bigint,
  quoteDecimals: number,
): string {
  const { value, decimals } = roundPriceDecimals(priceX96, quoteDecimals);
  return formatAmount(value, decimals, "nearest");
}

/** Smallest of the two fixed points' common ground: how the price moved, in whole percent, or null with nothing to compare. */
export function priceMovePercent(before: bigint, after: bigint): number | null {
  if (before <= 0n || after <= 0n) return null;
  const tenths = ((after - before) * 1000n) / before;
  return Number(tenths) / 10;
}

/** `amount` less `bps` basis points, rounded down: the least a trade accepts. */
export function withSlippage(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("The allowed price move must be from 0 to 100 percent");
  }
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** The latest time a trade may happen, `seconds` after the later of the chain's clock and this browser's. */
export function tradeDeadline(
  chainNow: number,
  browserNow: number,
  seconds = 1800,
): bigint {
  return BigInt(Math.max(chainNow, browserNow) + seconds);
}

/**
 * The tick grid of a round, for a price limit: a bid's highest price has to be a multiple of the auction's tick spacing
 * and above its clearing price. `wholePrice` is whole quote tokens per whole claim token, as typed.
 */
export function snapRoundLimit(
  wholePrice: string,
  quoteDecimals: number,
  tickSpacingX96: bigint,
): bigint | null {
  const asked = parseAmount(wholePrice, quoteDecimals + 18);
  if (asked === null || asked === 0n || tickSpacingX96 <= 0n) return null;
  // asked is the price in whole quote per whole claim, times 10^(quoteDecimals+18). The auction's price is quote base
  // units per claim base unit, times 2^96: whole price * 10^quoteDecimals / 10^18 * 2^96, which is asked * 2^96 / 10^36
  // whatever the quote's decimals. Rounded up, so a price is never taken below what was typed.
  const scale = 10n ** 36n;
  const x96 = (asked * Q96 + scale - 1n) / scale;
  const down = x96 - (x96 % tickSpacingX96);
  // Rounded up onto the grid: never below what the person typed.
  return down === x96 ? down : down + tickSpacingX96;
}

// ---- where a pool stands -------------------------------------------------------------------------

/**
 * Where a project's pool stands, in the five states the page tells apart. `none` is no pool at all for the project;
 * `waiting` is a pool whose opening round has not been settled; `live` trades; `failed` is a round that did not reach its
 * minimum (the pool is closed for good and the project may open another); `abandoned` is a pool that stopped for good
 * and pays its backers back.
 */
export type PoolPhase = "none" | "waiting" | "live" | "failed" | "abandoned";

export function poolPhase(snapshot: PoolSnapshot | null): PoolPhase {
  if (snapshot === null) return "none";
  switch (snapshot.round.state) {
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return snapshot.abandoned ? "abandoned" : "live";
  }
}

/** Where the opening round of a waiting pool stands on the auction's own clock. */
export type RoundStage = "bidding" | "ended";
export function roundStage(round: RoundView, block: number): RoundStage {
  return block < round.endBlock ? "bidding" : "ended";
}

/** What the next milestone step is, for the page and for the founder's button. */
export type NextMilestone =
  /** A post is open and backers may still leave, until `leaveBy`. */
  | { kind: "window"; leaveBy: number; releasableFrom: number }
  /** The window is over: anyone may release it until `until`. */
  | { kind: "release"; until: number }
  /** Nobody released it in time: it can only be cancelled. */
  | { kind: "cancel" }
  /** No post is open, and the next one may be posted from `from`. */
  | { kind: "wait"; from: number }
  /** No post is open and the founder may post one now. */
  | { kind: "ready" };

export function nextMilestone(
  snapshot: PoolSnapshot,
  now: number,
): NextMilestone {
  const m = snapshot.milestone;
  if (snapshot.milestoneId > 0n && m.status === "open") {
    if (now < m.windowEndsAt) {
      return {
        kind: "window",
        leaveBy: m.windowEndsAt,
        releasableFrom: m.windowEndsAt,
      };
    }
    if (now < m.resolveBy) return { kind: "release", until: m.resolveBy };
    return { kind: "cancel" };
  }
  return now < snapshot.nextClaimAt
    ? { kind: "wait", from: snapshot.nextClaimAt }
    : { kind: "ready" };
}

/** Whether the wallet's leave button is on: a window is running and the wallet may use it. */
export function canLeaveNow(snapshot: PoolSnapshot, now: number): boolean {
  return (
    snapshot.holderCanLeave &&
    snapshot.milestone.status === "open" &&
    now < snapshot.milestone.windowEndsAt
  );
}

// ---- events --------------------------------------------------------------------------------------

function topicOf(signature: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`;
}

/** The event signatures, exported so a test can bind them to the Solidity source. */
export const BACKING_EVENT_SIGNATURES = {
  bought:
    "Bought(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  sold: "Sold(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  left: "Left(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  milestonePosted:
    "MilestonePosted(uint256,bytes32,address,uint64,uint64,uint256,uint256)",
  milestoneResolved: "MilestoneResolved(uint256,bool,uint256)",
  roundBound: "RoundBound(address,address,uint256,uint256,uint64)",
  roundSeeded:
    "RoundSeeded(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  roundFailed: "RoundFailed(address,uint256,uint256)",
  redeemed: "Redeemed(address,uint256,uint256)",
  abandoned: "Abandoned(address,bool,uint256,uint256)",
} as const;

export const BACKING_TOPICS = Object.fromEntries(
  Object.entries(BACKING_EVENT_SIGNATURES).map(([name, signature]) => [
    name,
    topicOf(signature),
  ]),
) as { [K in keyof typeof BACKING_EVENT_SIGNATURES]: string };

/** Every event the page reads from a pool, as one `topic0` filter (an OR). */
const POOL_EVENT_TOPICS: readonly string[] = [
  BACKING_TOPICS.bought,
  BACKING_TOPICS.sold,
  BACKING_TOPICS.left,
  BACKING_TOPICS.milestonePosted,
  BACKING_TOPICS.milestoneResolved,
  BACKING_TOPICS.roundBound,
  BACKING_TOPICS.roundSeeded,
  BACKING_TOPICS.roundFailed,
  BACKING_TOPICS.abandoned,
];

/** One log as `eth_getLogs` returns it (hex quantities). */
export interface PoolLog {
  topics: readonly string[];
  data: string;
  blockNumber: string;
  logIndex?: string;
  transactionHash?: string;
}

interface EventBase {
  block: number;
  logIndex: number;
  tx: string;
}
export type PoolEvent = EventBase &
  (
    | {
        kind: "bought";
        buyer: string;
        quoteIn: bigint;
        unitsOut: bigint;
        fee: bigint;
        toEscrow: bigint;
        priceAfter: bigint;
      }
    | {
        kind: "sold";
        seller: string;
        unitsIn: bigint;
        quoteOut: bigint;
        fee: bigint;
        refund: bigint;
        priceAfter: bigint;
      }
    | {
        kind: "left";
        id: bigint;
        backer: string;
        unitsIn: bigint;
        quoteOut: bigint;
        fromEscrow: bigint;
        priceAfter: bigint;
      }
    | {
        kind: "milestone-posted";
        id: bigint;
        ref: string;
        by: string;
        windowEndsAt: number;
        resolveBy: number;
        tranche: bigint;
      }
    | {
        kind: "milestone-resolved";
        id: bigint;
        released: boolean;
        amount: bigint;
      }
    | {
        kind: "round-opened";
        auction: string;
        supply: bigint;
        minimumRaise: bigint;
        endBlock: number;
      }
    | {
        kind: "round-settled";
        received: bigint;
        unitsSold: bigint;
        clearingPriceX96: bigint;
        openingPrice: bigint;
      }
    | {
        kind: "round-failed";
        raised: bigint;
        minimumRaise: bigint;
      }
    | {
        kind: "abandoned";
        by: string;
        byVote: boolean;
        escrow: bigint;
      }
  );

function wordAddress(topic: string): string {
  if (!WORD_RE.test(topic)) throw new Error("an indexed address is not a word");
  return `0x${topic.slice(26)}`.toLowerCase();
}
function wordBigint(topic: string): bigint {
  if (!WORD_RE.test(topic)) throw new Error("an indexed value is not a word");
  return BigInt(topic);
}
function hexQuantity(value: string | undefined, what: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${what} is not a hex quantity`);
  }
  return asNumber(BigInt(value), what);
}

/**
 * One pool log as an event, or null for a topic this app does not read. A log that has the topic but not the shape throws:
 * it is not this pool's event, and a wrong figure must never be shown for it.
 */
export function decodePoolLog(log: PoolLog): PoolEvent | null {
  const topic0 = log.topics[0]?.toLowerCase();
  const base: EventBase = {
    block: hexQuantity(log.blockNumber, "log.blockNumber"),
    logIndex: log.logIndex ? hexQuantity(log.logIndex, "log.logIndex") : 0,
    tx: log.transactionHash ?? "",
  };
  const t = log.topics;
  const data = (types: AbiType[]) =>
    decodeParameters(types, log.data) as bigint[];
  switch (topic0) {
    case BACKING_TOPICS.bought: {
      const d = data(Array(7).fill("uint256"));
      return {
        ...base,
        kind: "bought",
        buyer: wordAddress(t[1]),
        quoteIn: d[0],
        unitsOut: d[1],
        fee: d[2],
        toEscrow: d[3],
        priceAfter: d[4],
      };
    }
    case BACKING_TOPICS.sold: {
      const d = data(Array(7).fill("uint256"));
      return {
        ...base,
        kind: "sold",
        seller: wordAddress(t[1]),
        unitsIn: d[0],
        quoteOut: d[1],
        fee: d[2],
        refund: d[3],
        priceAfter: d[4],
      };
    }
    case BACKING_TOPICS.left: {
      const d = data(Array(8).fill("uint256"));
      return {
        ...base,
        kind: "left",
        id: wordBigint(t[1]),
        backer: wordAddress(t[2]),
        unitsIn: d[0],
        quoteOut: d[1],
        fromEscrow: d[3],
        priceAfter: d[5],
      };
    }
    case BACKING_TOPICS.milestonePosted: {
      const d = data(Array(4).fill("uint256"));
      return {
        ...base,
        kind: "milestone-posted",
        id: wordBigint(t[1]),
        ref: t[2].toLowerCase(),
        by: wordAddress(t[3]),
        windowEndsAt: asNumber(d[0], "windowEndsAt"),
        resolveBy: asNumber(d[1], "resolveBy"),
        tranche: d[3],
      };
    }
    case BACKING_TOPICS.milestoneResolved: {
      const [released, amount] = decodeParameters(
        ["bool", "uint256"],
        log.data,
      ) as [boolean, bigint];
      return {
        ...base,
        kind: "milestone-resolved",
        id: wordBigint(t[1]),
        released,
        amount,
      };
    }
    case BACKING_TOPICS.roundBound: {
      const d = data(Array(3).fill("uint256"));
      return {
        ...base,
        kind: "round-opened",
        auction: wordAddress(t[1]),
        supply: d[0],
        minimumRaise: d[1],
        endBlock: asNumber(d[2], "endBlock"),
      };
    }
    case BACKING_TOPICS.roundSeeded: {
      const d = data(Array(8).fill("uint256"));
      return {
        ...base,
        kind: "round-settled",
        received: d[0],
        unitsSold: d[4],
        clearingPriceX96: d[5],
        openingPrice: d[6],
      };
    }
    case BACKING_TOPICS.roundFailed: {
      const d = data(Array(2).fill("uint256"));
      return {
        ...base,
        kind: "round-failed",
        raised: d[0],
        minimumRaise: d[1],
      };
    }
    case BACKING_TOPICS.abandoned: {
      const [byVote, escrow] = decodeParameters(
        ["bool", "uint256", "uint256"],
        log.data,
      ) as [boolean, bigint, bigint];
      return {
        ...base,
        kind: "abandoned",
        by: wordAddress(t[1]),
        byVote,
        escrow,
      };
    }
    default:
      return null;
  }
}

/** Newest first, then by position in the block: the order a feed shows them in. */
export function newestFirst(events: readonly PoolEvent[]): PoolEvent[] {
  return [...events].sort(
    (a, b) => b.block - a.block || b.logIndex - a.logIndex,
  );
}

// ---- the contracts' own refusals -----------------------------------------------------------------

/** Every custom error of the pool, its factory and the settings a launch checks, by name. */
export const BACKING_ERROR_NAMES = [
  "Expired",
  "ZeroAmount",
  "InsufficientUnits",
  "Slippage",
  "IsAbandoned",
  "EarlyCapReached",
  "TooLarge",
  "BadQuoteTransfer",
  "NotClaimant",
  "MilestoneOpen",
  "NoOpenMilestone",
  "TooSoon",
  "WindowOver",
  "WindowNotOver",
  "NoSay",
  "AlreadyDone",
  "NotAbandonable",
  "NothingOwed",
  "RoundNotLive",
  "RoundNotWaiting",
  "RoundNotOver",
  "BadAuction",
  "UnprovenDao",
  "AlreadyOpen",
  "NotAllowed",
  "RoundsOff",
  "MinimumTooLow",
  "NotEnoughGas",
  "ERC20InsufficientBalance",
  "ERC20InsufficientAllowance",
] as const;
export type BackingErrorName = (typeof BACKING_ERROR_NAMES)[number];

/** The error signatures whose selectors a wallet or a node may show instead of a name. */
export const BACKING_ERROR_SIGNATURES: Record<BackingErrorName, string> = {
  Expired: "Expired()",
  ZeroAmount: "ZeroAmount()",
  InsufficientUnits: "InsufficientUnits()",
  Slippage: "Slippage()",
  IsAbandoned: "IsAbandoned()",
  EarlyCapReached: "EarlyCapReached()",
  TooLarge: "TooLarge()",
  BadQuoteTransfer: "BadQuoteTransfer()",
  NotClaimant: "NotClaimant()",
  MilestoneOpen: "MilestoneOpen()",
  NoOpenMilestone: "NoOpenMilestone()",
  TooSoon: "TooSoon(uint256)",
  WindowOver: "WindowOver()",
  WindowNotOver: "WindowNotOver()",
  NoSay: "NoSay()",
  AlreadyDone: "AlreadyDone()",
  NotAbandonable: "NotAbandonable()",
  NothingOwed: "NothingOwed()",
  RoundNotLive: "RoundNotLive()",
  RoundNotWaiting: "RoundNotWaiting()",
  RoundNotOver: "RoundNotOver(uint256)",
  BadAuction: "BadAuction()",
  UnprovenDao: "UnprovenDao()",
  AlreadyOpen: "AlreadyOpen(address)",
  NotAllowed: "NotAllowed()",
  RoundsOff: "RoundsOff()",
  MinimumTooLow: "MinimumTooLow(uint128)",
  NotEnoughGas: "NotEnoughGas()",
  ERC20InsufficientBalance: "ERC20InsufficientBalance(address,uint256,uint256)",
  ERC20InsufficientAllowance:
    "ERC20InsufficientAllowance(address,uint256,uint256)",
};

/** Selector (`0x` and 8 hex characters) to error name. */
export const BACKING_ERROR_SELECTORS: ReadonlyMap<string, BackingErrorName> =
  new Map(
    (
      Object.entries(BACKING_ERROR_SIGNATURES) as [BackingErrorName, string][]
    ).map(([name, signature]) => [selectorOf(signature), name]),
  );

/**
 * The pool's refusal named in a failure's text, by its name (`Slippage`) or by the selector a node may show in its place.
 * The first match wins; null when the text names none of them.
 */
export function backingErrorIn(text: string): BackingErrorName | null {
  for (const name of BACKING_ERROR_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name;
  }
  for (const match of text.matchAll(/0x[0-9a-fA-F]{8}\b/g)) {
    const name = BACKING_ERROR_SELECTORS.get(match[0].toLowerCase());
    if (name) return name;
  }
  return null;
}

// ---- reading -------------------------------------------------------------------------------------

/** What the reader needs of a chain; the app's endpoint adapter and the tests' fake both provide it. */
export interface BackingChain {
  call(to: string, data: string): Promise<string>;
  /** The latest block's timestamp in seconds: what the pool's windows are measured against. */
  now(): Promise<number>;
  /** The latest block number, on the auction's clock for a round. */
  blockNumber(): Promise<number>;
}

/** The quote token as the page needs it: where it is, what it is called, and how many places an amount has. */
export interface QuoteFacts {
  address: string;
  decimals: number;
  /** Null when the token would not say its symbol: amounts are then shown without one. */
  symbol: string | null;
}

const SIG_DECIMALS = "decimals()";
const SIG_SYMBOL = "symbol()";
const SIG_BALANCE_OF = "balanceOf(address)";
const SIG_ALLOWANCE = "allowance(address,address)";
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

function wordToAddress(hex: string, what: string): string {
  const [w] = words(hex, 1, what);
  if (w >= 1n << 160n)
    throw new Error(`${what} answered a word that is not an address`);
  return `0x${w.toString(16).padStart(40, "0")}`;
}

function decodeSymbol(hex: string): string | null {
  try {
    const [value] = decodeParameters(["string"], hex);
    const text = String(value).trim();
    return text.length > 0 && text.length <= 12 ? text : null;
  } catch {
    return null;
  }
}

/**
 * A project's pool, by the DAO the app already knows from its own records or the kit's launch events. Never found by
 * walking the factory's list: that list holds strangers' DAOs next to real ones (BACKING-POOL.md, "Not protected").
 * Only the factory's own answer, the zero address, says there is no pool; every call that does not answer throws, so the
 * page keeps what it last read and says the read failed. It is never taken for "no pool".
 */
export async function readPoolAddress(
  chain: Pick<BackingChain, "call">,
  factory: string,
  dao: string,
): Promise<string | null> {
  const answer = await chain.call(
    address(factory, "The pool factory"),
    encodePoolOf(dao),
  );
  const pool = wordToAddress(answer, "poolOf(address)");
  return pool === ZERO_ADDRESS ? null : pool;
}

/** The token's own decimals and symbol: amounts are never shown with an assumed number of places. */
async function readQuoteFacts(
  chain: Pick<BackingChain, "call">,
  token: string,
): Promise<QuoteFacts> {
  const [decimalsHex, symbolHex] = await Promise.all([
    chain.call(token, encodeNoArgs(SIG_DECIMALS)),
    chain.call(token, encodeNoArgs(SIG_SYMBOL)).catch(() => null),
  ]);
  const [decimals] = words(decimalsHex, 1, "decimals()");
  if (decimals > 36n)
    throw new Error("the quote token reports more than 36 decimals");
  return {
    address: token,
    decimals: Number(decimals),
    symbol: symbolHex === null ? null : decodeSymbol(symbolHex),
  };
}

/** A pool's quote token and its own decimals and symbol: three bounded calls, for a feed that shows amounts and never reads the whole pool. */
export async function readPoolQuoteFacts(
  chain: Pick<BackingChain, "call">,
  pool: string,
): Promise<QuoteFacts> {
  const token = wordToAddress(
    await chain.call(
      address(pool, "The pool"),
      encodeNoArgs(BACKING_SIGNATURES.quote),
    ),
    "quote()",
  );
  return readQuoteFacts(chain, token);
}

/** What a project with no pool yet needs for the founder's "open backing": who may, the token, and whether rounds are offered. */
export interface NoPoolView {
  kind: "none";
  factory: string;
  dao: string;
  /** The founder on the DAO's record, who may open backing (and the DAO itself); the zero address when none is recorded. */
  founder: string;
  quote: QuoteFacts;
  quoteMatchesFactory: boolean;
  /** Set when the factory offers a fair opening round: its default minimum, in the token's base units. */
  round: { defaultMinimum: bigint } | null;
  now: number;
  block: number;
}

export interface PoolView {
  kind: "pool";
  pool: string;
  factory: string;
  dao: string;
  /** The founder on the pool's record, who may post milestones; the zero address when only the DAO may. */
  founder: string;
  snapshot: PoolSnapshot;
  phase: PoolPhase;
  quote: QuoteFacts;
  /** The pool's quote token is the one the factory says it was made with. */
  quoteMatchesFactory: boolean;
  /** The chain's clock and block when this was read. */
  now: number;
  block: number;
  /** The wallet whose side this is; null when none is connected. */
  holder: string | null;
  /** What the wallet holds of the quote token, and what the pool may already take. Null with no wallet. */
  walletMoney: { balance: bigint; allowance: bigint } | null;
  /** For a waiting round: its tick grid and floor (from the factory), and what the wallet already lets Permit2 take. */
  round: {
    floorPriceX96: bigint;
    tickSpacingX96: bigint;
    permit2Allowance: bigint | null;
  } | null;
}

/**
 * Everything the Backing block shows about a project's pool and one wallet, at one moment. A pool answers in one
 * `snapshot` call; the rest is the token's facts, the founder, the chain's clock, and the wallet's money. Each is one
 * bounded call: nothing loops.
 */
export async function readPool(
  chain: BackingChain,
  input: {
    factory: string;
    dao: string;
    holder: string | null;
    expectedQuote?: string | null;
  },
): Promise<NoPoolView | PoolView> {
  const factory = address(input.factory, "The pool factory");
  const dao = address(input.dao, "The project's DAO");
  const holder =
    input.holder === null ? null : address(input.holder, "The wallet");
  const expected = input.expectedQuote
    ? address(input.expectedQuote, "The backing token")
    : null;
  const pool = await readPoolAddress(chain, factory, dao);
  if (pool === null) {
    const [
      founderHex,
      factoryQuoteHex,
      auctionFactoryHex,
      minimumHex,
      now,
      block,
    ] = await Promise.all([
      chain.call(factory, encodeFounderOf(dao)),
      chain.call(factory, encodeNoArgs(BACKING_SIGNATURES.factoryQuote)),
      chain.call(factory, encodeNoArgs(BACKING_SIGNATURES.auctionFactory)),
      chain.call(factory, encodeNoArgs(BACKING_SIGNATURES.defaultMinimumRaise)),
      chain.now(),
      chain.blockNumber(),
    ]);
    const factoryQuote = wordToAddress(factoryQuoteHex, "quote()");
    const roundsOffered =
      wordToAddress(auctionFactoryHex, "auctionFactory()") !== ZERO_ADDRESS;
    return {
      kind: "none",
      factory,
      dao,
      founder: wordToAddress(founderHex, "founderOf(address)"),
      quote: await readQuoteFacts(chain, factoryQuote),
      quoteMatchesFactory: expected === null || expected === factoryQuote,
      round: roundsOffered
        ? { defaultMinimum: words(minimumHex, 1, "defaultMinimumRaise()")[0] }
        : null,
      now,
      block,
    };
  }
  // `snapshot` is asked about the zero address when no wallet is connected: the pool alone.
  const [snapshotHex, founderHex, quoteHex, factoryQuoteHex, now, block] =
    await Promise.all([
      chain.call(pool, encodeSnapshot(holder ?? ZERO_ADDRESS)),
      chain.call(pool, encodeNoArgs(BACKING_SIGNATURES.founder)),
      chain.call(pool, encodeNoArgs(BACKING_SIGNATURES.quote)),
      chain.call(factory, encodeNoArgs(BACKING_SIGNATURES.factoryQuote)),
      chain.now(),
      chain.blockNumber(),
    ]);
  const snapshot = decodeSnapshot(snapshotHex);
  const quoteAddress = wordToAddress(quoteHex, "quote()");
  const factoryQuote = wordToAddress(factoryQuoteHex, "quote()");
  const [quoteFacts, moneyHex] = await Promise.all([
    readQuoteFacts(chain, quoteAddress),
    holder === null
      ? Promise.resolve(null)
      : Promise.all([
          chain.call(
            quoteAddress,
            encodeFunctionData(SIG_BALANCE_OF, ["address"], [holder]),
          ),
          chain.call(
            quoteAddress,
            encodeFunctionData(
              SIG_ALLOWANCE,
              ["address", "address"],
              [holder, pool],
            ),
          ),
        ]),
  ]);
  let round: PoolView["round"] = null;
  if (snapshot.round.state === "waiting") {
    const [floorHex, tickHex, permitHex] = await Promise.all([
      chain.call(factory, encodeNoArgs(BACKING_SIGNATURES.roundFloorPriceX96)),
      chain.call(factory, encodeNoArgs(BACKING_SIGNATURES.roundTickSpacingX96)),
      holder === null
        ? Promise.resolve(null)
        : chain.call(
            quoteAddress,
            encodeFunctionData(
              SIG_ALLOWANCE,
              ["address", "address"],
              [holder, PERMIT2],
            ),
          ),
    ]);
    round = {
      floorPriceX96: words(floorHex, 1, "roundFloorPriceX96()")[0],
      tickSpacingX96: words(tickHex, 1, "roundTickSpacingX96()")[0],
      permit2Allowance:
        permitHex === null ? null : words(permitHex, 1, "allowance()")[0],
    };
  }
  return {
    kind: "pool",
    pool,
    factory,
    dao,
    founder: wordToAddress(founderHex, "founder()"),
    snapshot,
    phase: poolPhase(snapshot),
    quote: quoteFacts,
    quoteMatchesFactory:
      quoteAddress === factoryQuote &&
      (expected === null || expected === quoteAddress),
    now,
    block,
    holder,
    walletMoney:
      moneyHex === null
        ? null
        : {
            balance: words(moneyHex[0], 1, "balanceOf()")[0],
            allowance: words(moneyHex[1], 1, "allowance()")[0],
          },
    round,
  };
}

/** What a buy, a sale or a leave would do right now, asked of the pool itself. */
export async function readBuyQuote(
  chain: Pick<BackingChain, "call">,
  pool: string,
  quoteIn: bigint,
): Promise<BuyQuote> {
  return decodeBuyQuote(
    await chain.call(address(pool, "The pool"), encodeQuoteBuy(quoteIn)),
  );
}
export async function readSellQuote(
  chain: Pick<BackingChain, "call">,
  pool: string,
  holder: string,
  unitsIn: bigint,
): Promise<SellQuote> {
  return decodeSellQuote(
    await chain.call(
      address(pool, "The pool"),
      encodeQuoteSell(holder, unitsIn),
    ),
  );
}
export async function readLeaveQuote(
  chain: Pick<BackingChain, "call">,
  pool: string,
  holder: string,
): Promise<LeaveQuote> {
  return decodeLeaveQuote(
    await chain.call(address(pool, "The pool"), encodeQuoteLeave(holder)),
  );
}

// ---- the history of a pool -----------------------------------------------------------------------

/** The most events one read keeps. A pool with more says so (`cut`) rather than showing only some without saying. */
export const MAX_POOL_EVENTS = 400;

export interface PoolEventsRead {
  /** Newest first. */
  events: PoolEvent[];
  /** More happened than the read keeps: the oldest are missing. */
  cut: boolean;
  /** Logs that were this pool's topics but could not be read as events; never shown as figures. */
  unreadable: number;
}

/**
 * The pool's events, from the build's history start, as one bounded read: the log request is one OR over the pool's own
 * topics, at most `MAX_POOL_EVENTS` newest are kept, and a log that does not decode is counted, not guessed at.
 */
export async function readPoolEvents(
  logs: (filter: {
    address: string;
    topics: (string | string[] | null)[];
  }) => Promise<readonly PoolLog[]>,
  pool: string,
  limit = MAX_POOL_EVENTS,
): Promise<PoolEventsRead> {
  const raw = await logs({
    address: address(pool, "The pool"),
    topics: [[...POOL_EVENT_TOPICS]],
  });
  const events: PoolEvent[] = [];
  let unreadable = 0;
  for (const log of raw) {
    try {
      const event = decodePoolLog(log);
      if (event) events.push(event);
    } catch {
      unreadable += 1;
    }
  }
  const ordered = newestFirst(events);
  return {
    events: ordered.slice(0, limit),
    cut: ordered.length > limit,
    unreadable,
  };
}

/** What a pool's events add up to: what was paid in, and who paid. Both are lower bounds when the read was cut. */
export interface PoolTotals {
  paidIn: bigint;
  backers: number;
}
export function poolTotals(events: readonly PoolEvent[]): PoolTotals {
  let paidIn = 0n;
  const buyers = new Set<string>();
  for (const event of events) {
    if (event.kind === "bought") {
      paidIn += event.quoteIn;
      buyers.add(event.buyer);
    } else if (event.kind === "round-settled") {
      // The round's raise arrived as one sum; who paid it is the auction's record, not the pool's.
      paidIn += event.received;
    }
  }
  return { paidIn, backers: buyers.size };
}

/** The milestones in the events, oldest first, each with how it ended (still open when nothing resolved it). */
export interface MilestoneRecord {
  id: bigint;
  ref: string;
  postedBlock: number;
  windowEndsAt: number;
  resolveBy: number;
  tranche: bigint;
  outcome: "open" | "released" | "cancelled";
  releasedAmount: bigint;
  /** Backers who left during its window, counted from the events read. */
  leavers: number;
}

export function milestoneRecords(
  events: readonly PoolEvent[],
): MilestoneRecord[] {
  const byId = new Map<bigint, MilestoneRecord>();
  for (const event of [...events].reverse()) {
    if (event.kind === "milestone-posted") {
      byId.set(event.id, {
        id: event.id,
        ref: event.ref,
        postedBlock: event.block,
        windowEndsAt: event.windowEndsAt,
        resolveBy: event.resolveBy,
        tranche: event.tranche,
        outcome: "open",
        releasedAmount: 0n,
        leavers: 0,
      });
    } else if (event.kind === "milestone-resolved") {
      const found = byId.get(event.id);
      if (found) {
        found.outcome = event.released ? "released" : "cancelled";
        found.releasedAmount = event.amount;
      }
    } else if (event.kind === "left") {
      const found = byId.get(event.id);
      if (found) found.leavers += 1;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
