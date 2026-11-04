/**
 * The secondary market (docs/v3-review/SECONDARY-LISTING-SPEC.md,
 * `contracts/src/SecondaryMarket.sol`): one market per DAO, created by its
 * `SecondaryMarketFactory`, where holders offer existing Shares and buyers bid
 * the DAO's one quote token, and a weekly round clears at a single price over a
 * grid the round froze when it opened.
 *
 * This module is the app's only adapter for that market: the signatures, a
 * three-way read (a market, genuinely no market, or a read we do not have), the
 * decoders for each tuple, where a round stands, and the calldata for the DAO's
 * listing terms and a holder's own actions.
 *
 * Units: every price is quote base units per whole lot, and a lot is the
 * market's own `lotSize` Shares base units — read `lotSize()` and the quote's
 * `decimals()` yourself. Nothing here scales an amount by decimals.
 *
 * Pure apart from the reader, whose chain is injected
 * (`secondary.test.mjs` runs it against a fake one); every selector is pinned
 * to `cast sig` in the same test.
 */

import { encodeFunctionData } from "./evmAbi.ts";
import { encodeCall0 } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The most grid levels a listing may set (`SecondaryMarket.MAX_LEVELS`). */
const MAX_LEVELS = 64;
/** The most lots one order holds (`SecondaryMarket.MAX_ORDER_LOTS`). */
const MAX_ORDER_LOTS = 1n << 96n;

/** How long a round takes orders (`SecondaryMarket.BIDDING`). */
export const SECONDARY_BIDDING = 3 * 86_400;
/** How long after bidding a round can still be settled before it is void. */
export const SECONDARY_SETTLE_WINDOW = 2 * 86_400;
/** The least time between two openings of one market's rounds. */
export const SECONDARY_EVERY = 7 * 86_400;

/**
 * Every function of `SecondaryMarketFactory` and `SecondaryMarket` this app
 * reads or calls, as the file's single source of truth. The public mapping
 * `marketOf` and the public struct getters `listing`, `rounds`, `sells` and
 * `bids` are the contract's own generated getters.
 */
export const SECONDARY_SIGNATURES = {
  /** On the factory: the DAO's one market, or the zero address before it exists. */
  marketOf: "marketOf(address)",
  listing: "listing()",
  /** `(minPrice, step, levels, opensAt, closesAt, settleDeadline, asked, wanted, price, settled, sellersShare)`. */
  rounds: "rounds(uint256)",
  /** `(lots, minStep, filled, orderId, escrowReturned, proceedsPaid)`. */
  sells: "sells(uint256,address)",
  /** `(lots, maxStep, filled, orderId, cancelled, sharesPaid, refundDone)`. */
  bids: "bids(uint256,address)",
  roundCount: "roundCount()",
  lastOpenAt: "lastOpenAt()",
  /** The quote base units of one lot at grid level `level` in round `id`. */
  priceAt: "priceAt(uint256,uint256)",
  /** `(level, matched, sellersShare)`: the result `settle` would record for the orders as they stand. */
  clearingOf: "clearingOf(uint256)",
  /** The DAO only. */
  configureListing: "configureListing(bool,uint128,uint128,uint32)",
  openRound: "openRound()",
  sell: "sell(uint256,uint128,uint16)",
  bid: "bid(uint256,uint128,uint16)",
  cancelSell: "cancelSell(uint256)",
  cancelBid: "cancelBid(uint256)",
  settle: "settle(uint256)",
  claimShares: "claimShares(uint256,address)",
  claimQuote: "claimQuote(uint256,address)",
} as const;

// ---- inputs --------------------------------------------------------------------------------------

/** A contract or wallet address, lowercased: the form every call and comparison uses. */
function address(value: string, what: string): string {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed)) throw new Error(`${what} is not an address`);
  return trimmed.toLowerCase();
}

/** A value that must fit its Solidity width, or the ABI encoder would truncate it. */
function fit(value: bigint, bits: number, what: string): bigint {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new Error(`${what} does not fit in ${bits} bits`);
  }
  return value;
}

/** A whole count that must fit its Solidity width (`levels`, `minStep`, `maxStep`). */
function count(value: number, bits: number, what: string): bigint {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a whole number`);
  }
  return fit(BigInt(value), bits, what);
}

/** One order's size: whole lots, from one up to the contract's own cap. */
function lotsOf(lots: bigint): bigint {
  if (lots <= 0n || lots > MAX_ORDER_LOTS) {
    throw new Error(`An order holds 1 to ${MAX_ORDER_LOTS} whole lots`);
  }
  return lots;
}

// ---- calls ---------------------------------------------------------------------------------------

/**
 * The DAO's own call: whether its market has a listing, and the exact per-lot
 * price bounds and grid. The contract ignores the terms when `enabled` is
 * false, so they are only checked when it is true: a lowest price above zero, a
 * highest above it, 1 to 64 levels, and a range that divides into whole steps
 * (its `InvalidTerms` rules, refused here rather than as a reverted vote).
 */
export function encodeConfigureListing(input: {
  market: string;
  enabled: boolean;
  /** The lowest price per lot, in quote base units. */
  minPrice: bigint;
  maxPrice: bigint;
  /** Grid levels: the step is `(maxPrice - minPrice) / levels`. */
  levels: number;
}): string {
  address(input.market, "The market");
  if (input.enabled) {
    const min = fit(input.minPrice, 128, "The lowest price");
    const max = fit(input.maxPrice, 128, "The highest price");
    if (min === 0n) throw new Error("The lowest price must be above zero");
    if (max <= min)
      throw new Error("The highest price must be above the lowest");
    if (
      !Number.isInteger(input.levels) ||
      input.levels < 1 ||
      input.levels > MAX_LEVELS
    ) {
      throw new Error(`The grid must have 1 to ${MAX_LEVELS} levels`);
    }
    if ((max - min) % BigInt(input.levels) !== 0n) {
      throw new Error("The price range must divide into whole grid steps");
    }
  }
  return encodeFunctionData(
    SECONDARY_SIGNATURES.configureListing,
    ["bool", "uint128", "uint128", "uint32"],
    [
      input.enabled,
      input.minPrice,
      input.maxPrice,
      count(input.levels, 32, "The grid levels"),
    ],
  );
}

/** Anyone may open the next round, at least {@link SECONDARY_EVERY} after the last one. */
export function encodeOpenRound(market: string): string {
  address(market, "The market");
  return encodeCall0(SECONDARY_SIGNATURES.openRound);
}

/**
 * Offer `lots` whole lots in round `roundId` at no less than grid level
 * `minStep`. The Shares (`lots * lotSize`) are escrowed by the market until the
 * round settles, goes void, or the offer is cancelled; approve them first, and
 * note the DAO itself can never sell.
 */
export function encodeSell(
  market: string,
  roundId: bigint,
  lots: bigint,
  minStep: number,
): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.sell,
    ["uint256", "uint128", "uint16"],
    [
      fit(roundId, 256, "The round"),
      lotsOf(lots),
      count(minStep, 16, "The lowest price level"),
    ],
  );
}

/**
 * Bid for `lots` whole lots in round `roundId` at no more than grid level
 * `maxStep`. The quote (`lots * priceAt(roundId, maxStep)`) is escrowed until
 * the round settles, goes void, or the bid is cancelled; approve it first.
 */
export function encodeBid(
  market: string,
  roundId: bigint,
  lots: bigint,
  maxStep: number,
): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.bid,
    ["uint256", "uint128", "uint16"],
    [
      fit(roundId, 256, "The round"),
      lotsOf(lots),
      count(maxStep, 16, "The highest price level"),
    ],
  );
}

/** Take an offer back while bidding is open: the Shares return in the same transaction. */
export function encodeCancelSell(market: string, roundId: bigint): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.cancelSell,
    ["uint256"],
    [fit(roundId, 256, "The round")],
  );
}

/** Take a bid back while bidding is open: the refund is then collected with {@link encodeClaimQuote}. */
export function encodeCancelBid(market: string, roundId: bigint): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.cancelBid,
    ["uint256"],
    [fit(roundId, 256, "The round")],
  );
}

/** Settle a round within its window; anyone may call it. Past the deadline the round is void instead. */
export function encodeSettle(market: string, roundId: bigint): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.settle,
    ["uint256"],
    [fit(roundId, 256, "The round")],
  );
}

/** Deliver `who` what round `roundId` owes them in Shares: what they bought, or a void round's own offer back. */
export function encodeClaimShares(
  market: string,
  roundId: bigint,
  who: string,
): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.claimShares,
    ["uint256", "address"],
    [fit(roundId, 256, "The round"), address(who, "The claimant")],
  );
}

/** Pay `who` what round `roundId` owes them in quote: a seller's proceeds, a buyer's refund, a cancelled bid's escrow. */
export function encodeClaimQuote(
  market: string,
  roundId: bigint,
  who: string,
): string {
  address(market, "The market");
  return encodeFunctionData(
    SECONDARY_SIGNATURES.claimQuote,
    ["uint256", "address"],
    [fit(roundId, 256, "The round"), address(who, "The claimant")],
  );
}

// ---- decoding ------------------------------------------------------------------------------------

/**
 * Exactly `expected` 32-byte words, or a thrown error. A short, empty or
 * oversized answer is a read we do not have, never a set of zeros to reshape
 * into a plausible default (Review-Proven Rule 1).
 */
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

/** A word that must fit its Solidity width: a wider one is not this tuple. */
function fits(word: bigint, bits: number, what: string): bigint {
  if (word >= 1n << BigInt(bits)) {
    throw new Error(`${what} does not fit in ${bits} bits`);
  }
  return word;
}

/** A word that must be exactly `0` or `1`: an ABI bool is never anything else. */
function flag(word: bigint, what: string): boolean {
  if (word !== 0n && word !== 1n) throw new Error(`${what} is not a boolean`);
  return word === 1n;
}

/** A unix timestamp the contract keeps in a uint64. */
const stamp = (word: bigint, what: string): number =>
  Number(fits(word, 64, what));

/** The listing's existence and terms, as the DAO last set them. */
export interface Listing {
  enabled: boolean;
  /** The lowest price per lot, in quote base units; zero when disabled. */
  minPrice: bigint;
  maxPrice: bigint;
  /** Grid levels; zero when disabled. */
  levels: number;
}

/** One round's frozen terms and its settlement result, as `rounds(uint256)` returns them. */
export interface RoundRecord {
  /** The lowest price per lot, in quote base units. */
  minPrice: bigint;
  /** The price per grid level, in quote base units. */
  step: bigint;
  levels: number;
  /** When bidding opened. */
  opensAt: number;
  /** When bidding closed: no offer or bid is accepted from this second on. */
  closesAt: number;
  /** When the round stops being settlable and becomes void. */
  settleDeadline: number;
  /** Lots offered. */
  asked: bigint;
  /** Lots bid for. */
  wanted: bigint;
  /** The grid level it settled at; 0 until it settles. */
  price: number;
  settled: boolean;
  /** At the clearing price, sellers were the oversubscribed side sharing the remainder. */
  sellersShare: boolean;
}

/** A round plus where it stands now. */
export interface RoundView extends RoundRecord {
  phase: RoundPhase;
  /**
   * The whole lots that really changed hands: what `clearingOf` answers for a settled round, 0 for any
   * other. `asked` and `wanted` are running totals of the open orders and say nothing about this, and a
   * settled round that matched nothing still stores a price level (0), so only `matched` tells a trade
   * from a round where nothing crossed.
   */
  matched: bigint;
}

/** One seller's offer in one round, as `sells(uint256,address)` returns it. */
export interface SellOrderView {
  lots: bigint;
  /** The lowest grid level the seller accepts. */
  minStep: number;
  /** Lots sold; only settlement writes it. */
  filled: bigint;
  orderId: bigint;
  /** The unsold escrow already went back to the seller. */
  escrowReturned: boolean;
  /** The seller's proceeds were already paid. */
  proceedsPaid: boolean;
}

/** One buyer's bid in one round, as `bids(uint256,address)` returns it. */
export interface BidOrderView {
  lots: bigint;
  /** The highest grid level the buyer accepts. */
  maxStep: number;
  /** Lots bought; only settlement writes it. */
  filled: bigint;
  orderId: bigint;
  /** Taken out of the round while bidding was open. */
  cancelled: boolean;
  /** The bought Shares were already delivered. */
  sharesPaid: boolean;
  /** The quote owed back was already paid. */
  refundDone: boolean;
}

/** What `clearingOf(uint256)` says the orders as they stand would settle at. */
export interface ClearingView {
  /** The grid level that matches the most lots. */
  level: number;
  /** The whole lots it matches. */
  matched: bigint;
  /** Sellers are the oversubscribed side sharing the remainder at that price. */
  sellersShare: boolean;
}

/** The listing's four words: `enabled`, `minPrice`, `maxPrice`, `levels`. */
export function decodeListing(hex: string): Listing {
  const w = words(hex, 4, "listing()");
  return {
    enabled: flag(w[0], "listing().enabled"),
    minPrice: fits(w[1], 128, "listing().minPrice"),
    maxPrice: fits(w[2], 128, "listing().maxPrice"),
    levels: Number(fits(w[3], 32, "listing().levels")),
  };
}

/** A round's eleven words, in the contract's order. */
export function decodeRound(hex: string): RoundRecord {
  const w = words(hex, 11, "rounds(uint256)");
  return {
    minPrice: fits(w[0], 128, "rounds().minPrice"),
    step: fits(w[1], 128, "rounds().step"),
    levels: Number(fits(w[2], 32, "rounds().levels")),
    opensAt: stamp(w[3], "rounds().opensAt"),
    closesAt: stamp(w[4], "rounds().closesAt"),
    settleDeadline: stamp(w[5], "rounds().settleDeadline"),
    asked: w[6],
    wanted: w[7],
    price: Number(fits(w[8], 16, "rounds().price")),
    settled: flag(w[9], "rounds().settled"),
    sellersShare: flag(w[10], "rounds().sellersShare"),
  };
}

/** A seller's six words; all zero is an address with no offer in that round. */
export function decodeSell(hex: string): SellOrderView {
  const w = words(hex, 6, "sells(uint256,address)");
  return {
    lots: fits(w[0], 128, "sells().lots"),
    minStep: Number(fits(w[1], 16, "sells().minStep")),
    filled: fits(w[2], 128, "sells().filled"),
    orderId: fits(w[3], 64, "sells().orderId"),
    escrowReturned: flag(w[4], "sells().escrowReturned"),
    proceedsPaid: flag(w[5], "sells().proceedsPaid"),
  };
}

/** A buyer's seven words; all zero is an address with no bid in that round. */
export function decodeBid(hex: string): BidOrderView {
  const w = words(hex, 7, "bids(uint256,address)");
  return {
    lots: fits(w[0], 128, "bids().lots"),
    maxStep: Number(fits(w[1], 16, "bids().maxStep")),
    filled: fits(w[2], 128, "bids().filled"),
    orderId: fits(w[3], 64, "bids().orderId"),
    cancelled: flag(w[4], "bids().cancelled"),
    sharesPaid: flag(w[5], "bids().sharesPaid"),
    refundDone: flag(w[6], "bids().refundDone"),
  };
}

/** The clearing's three words: `level`, `matched`, `sellersShare`. */
export function decodeClearing(hex: string): ClearingView {
  const w = words(hex, 3, "clearingOf(uint256)");
  return {
    level: Number(fits(w[0], 32, "clearingOf().level")),
    matched: w[1],
    sellersShare: flag(w[2], "clearingOf().sellersShare"),
  };
}

/**
 * A round as the page shows it: its record, its phase now, and the lots it matched. Only a settled round
 * is asked for its clearing, since for an open one it is a preview and for a void one nothing traded; the
 * orders are not touched by settling, so `clearingOf` still answers the recorded result. A failed call
 * throws: a clearing we could not read is not a round that matched nothing (Review-Proven Rule 1).
 */
async function viewRound(
  chain: Pick<WorkChain, "call">,
  market: string,
  id: bigint,
  record: RoundRecord,
  now: number,
): Promise<RoundView> {
  const phase = roundPhase(record, now);
  const matched = record.settled
    ? decodeClearing(
        await chain.call(
          market,
          encodeFunctionData(
            SECONDARY_SIGNATURES.clearingOf,
            ["uint256"],
            [id],
          ),
        ),
      ).matched
    : 0n;
  return { ...record, phase, matched };
}

/** What one lot costs at grid level `level`, as the round's frozen grid prices it. */
export function lotPriceAt(
  round: Pick<RoundRecord, "minPrice" | "step">,
  level: number,
): bigint {
  return (
    round.minPrice + BigInt(count(level, 32, "The price level")) * round.step
  );
}

// ---- where a round stands --------------------------------------------------------------------------

/** Where a round stands: no round, taking orders, waiting to settle, settled, or past its deadline. */
export type RoundPhase = "none" | "bidding" | "settling" | "settled" | "void";

/**
 * Where a round stands, by the contract's own windows. Orders are accepted up
 * to but not including `closesAt`; settling runs from `closesAt` up to but not
 * including `settleDeadline`; and a round nobody settled by then is void
 * (`voided`: `!settled && now >= settleDeadline`), whichever side of the
 * deadline the caller looks from.
 */
export function roundPhase(
  round: Pick<RoundRecord, "settled" | "closesAt" | "settleDeadline"> | null,
  now: number,
): RoundPhase {
  if (!round) return "none";
  if (round.settled) return "settled";
  if (now >= round.settleDeadline) return "void";
  return now < round.closesAt ? "bidding" : "settling";
}

// ---- reading -------------------------------------------------------------------------------------

/** The connected wallet's side of the market's current round. */
export interface WalletView {
  /** The wallet these orders belong to, lowercased; null when none is connected. */
  address: string | null;
  /** Its offer in the current round, or null when it has none. */
  sell: SellOrderView | null;
  /** Its bid in the current round, or null when it has none. */
  bid: BidOrderView | null;
}

/** What to read, and what "now" means to the round's windows. */
export interface SecondaryReadInput {
  /** The `SecondaryMarketFactory` that lists this DAO's market. */
  factory: string;
  dao: string;
  /** The connected account, or null when none is connected. */
  wallet: string | null;
  /** The chain's clock in unix seconds, for the round's phase. */
  now: number;
}

/**
 * What reading a DAO's market told us — three answers, never two. A failed read
 * is `unreadable`, never `absent`: "this DAO has no market" is a claim about
 * the factory's registry, and a question the node did not answer is not
 * evidence for it (Review-Proven Rule 1).
 */
export type SecondaryMarketRead =
  | {
      kind: "present";
      /** The DAO's market, lowercased. */
      market: string;
      listing: Listing;
      /** The market's latest round, or null before its first. */
      round: RoundView | null;
      wallet: WalletView;
    }
  /** `marketOf` answered the zero address: the factory has no market for this DAO. */
  | { kind: "absent" }
  /** No answer, or an answer that is not the tuple we asked for. */
  | { kind: "unreadable"; reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The DAO's market, its listing, its latest round and the wallet's orders in
 * it.
 *
 * Only the factory's own registry answers absence: the zero address. A node
 * that timed out, was unreachable or busy, a transport failure, and an answer
 * that is not one address word are all `unreadable`, so no caller can render a
 * failed read as "this DAO has no secondary market".
 *
 * A revert from `marketOf` is `unreadable` too, and deliberately so: it is the
 * generated getter of a mapping, which cannot revert, and an unlisted DAO is
 * the zero address rather than a refusal. A revert therefore means the address
 * we called is not this factory — which says nothing about whether the DAO has
 * a market, and must not become an authoritative "none".
 *
 * Throws when `factory`, `dao` or `wallet` is not an address: that is a caller
 * or configuration mistake, not something the chain told us.
 */
export async function readSecondaryMarket(
  chain: Pick<WorkChain, "call">,
  input: SecondaryReadInput,
): Promise<SecondaryMarketRead> {
  const factory = address(input.factory, "The market factory");
  const dao = address(input.dao, "The DAO");
  const wallet =
    input.wallet === null ? null : address(input.wallet, "The wallet");

  let market: string;
  try {
    const answer = await chain.call(
      factory,
      encodeFunctionData(SECONDARY_SIGNATURES.marketOf, ["address"], [dao]),
    );
    const w = words(answer, 1, "marketOf(address)");
    // An address word keeps its address in the low 20 bytes; a wider word is
    // not an address, and taking its low bytes would invent one.
    if (w[0] >= 1n << 160n) {
      throw new Error(
        "marketOf(address) answered a word that is not an address",
      );
    }
    market = `0x${w[0].toString(16).padStart(40, "0")}`;
  } catch (error) {
    return { kind: "unreadable", reason: reasonOf(error) };
  }
  if (market === ZERO_ADDRESS) return { kind: "absent" };

  try {
    const [listingHex, countHex] = await Promise.all([
      chain.call(market, encodeCall0(SECONDARY_SIGNATURES.listing)),
      chain.call(market, encodeCall0(SECONDARY_SIGNATURES.roundCount)),
    ]);
    const listing = decodeListing(listingHex);
    const latest = words(countHex, 1, "roundCount()")[0];
    const mine: WalletView = { address: wallet, sell: null, bid: null };
    // Round ids start at 1 (`++roundCount`), so zero is a market that never opened one.
    if (latest === 0n)
      return { kind: "present", market, listing, round: null, wallet: mine };
    const record = decodeRound(
      await chain.call(
        market,
        encodeFunctionData(SECONDARY_SIGNATURES.rounds, ["uint256"], [latest]),
      ),
    );
    // `_round` treats a zero `opensAt` as no such round; the getter itself
    // never reverts, so a zeroed record is how an unknown id answers.
    if (record.opensAt === 0) {
      return { kind: "present", market, listing, round: null, wallet: mine };
    }
    const round = await viewRound(chain, market, latest, record, input.now);
    if (!wallet)
      return { kind: "present", market, listing, round, wallet: mine };
    const order = (signature: string) =>
      chain.call(
        market,
        encodeFunctionData(signature, ["uint256", "address"], [latest, wallet]),
      );
    const [sellHex, bidHex] = await Promise.all([
      order(SECONDARY_SIGNATURES.sells),
      order(SECONDARY_SIGNATURES.bids),
    ]);
    const sell = decodeSell(sellHex);
    const bid = decodeBid(bidHex);
    return {
      kind: "present",
      market,
      listing,
      round,
      wallet: {
        address: wallet,
        // `cancelSell` deletes the order, so no lots is "no offer", not an empty one.
        sell: sell.lots === 0n ? null : sell,
        bid: bid.lots === 0n ? null : bid,
      },
    };
  } catch (error) {
    return { kind: "unreadable", reason: reasonOf(error) };
  }
}

// ---- the wallet's earlier rounds -----------------------------------------------------------------

/**
 * How many rounds before the latest one are checked for what a wallet is still
 * owed. A claim never expires and anyone may open the next round a week after
 * the last, so a finished round keeps owing its orders after the page has moved
 * on to a newer one; the look-back is bounded so one read stays a fixed number
 * of calls (Review-Proven Rule 4), and a round older than it is reported as
 * `unchecked`, never silently hidden.
 */
export const SECONDARY_LOOKBACK = 8;

/** One earlier round the wallet took part in, with its orders in it. */
export interface EarlierRound {
  /** The round's id, which every claim names. */
  id: bigint;
  round: RoundView;
  /** The wallet's offer in that round, or null when it made none. */
  sell: SellOrderView | null;
  /** The wallet's bid in that round, or null when it made none. */
  bid: BidOrderView | null;
}

/** The wallet's earlier rounds that hold an order of its own, newest first, and how many older rounds were not looked at. */
export interface EarlierRoundsRead {
  rounds: EarlierRound[];
  /** Rounds older than the look-back, which this read did not ask about. */
  unchecked: bigint;
}

/**
 * The rounds before `latest` that `wallet` made an offer or a bid in, looking at
 * the last {@link SECONDARY_LOOKBACK} of them. The latest round is read with the
 * market itself ({@link readSecondaryMarket}); this reads the ones it left
 * behind, so a settled or void round that still owes the wallet is not lost when
 * a newer round opens.
 *
 * A failed call throws: a round we could not read is not a round with nothing in
 * it (Review-Proven Rule 1). Round ids start at 1 and `latest` is the market's
 * `roundCount`, so every id below it exists; a zeroed record would mean the
 * answer is not this market's and throws too.
 */
export async function readEarlierRounds(
  chain: Pick<WorkChain, "call">,
  input: { market: string; wallet: string; latest: bigint; now: number },
): Promise<EarlierRoundsRead> {
  const market = address(input.market, "The market");
  const wallet = address(input.wallet, "The wallet");
  if (input.latest < 1n) return { rounds: [], unchecked: 0n };
  const lowest =
    input.latest > BigInt(SECONDARY_LOOKBACK)
      ? input.latest - BigInt(SECONDARY_LOOKBACK)
      : 1n;
  const ids: bigint[] = [];
  for (let id = input.latest - 1n; id >= lowest; id--) ids.push(id);
  const read = await Promise.all(
    ids.map(async (id): Promise<EarlierRound | null> => {
      const order = (signature: string) =>
        chain.call(
          market,
          encodeFunctionData(signature, ["uint256", "address"], [id, wallet]),
        );
      const [roundHex, sellHex, bidHex] = await Promise.all([
        chain.call(
          market,
          encodeFunctionData(SECONDARY_SIGNATURES.rounds, ["uint256"], [id]),
        ),
        order(SECONDARY_SIGNATURES.sells),
        order(SECONDARY_SIGNATURES.bids),
      ]);
      const record = decodeRound(roundHex);
      if (record.opensAt === 0) {
        throw new Error(`the market has no round ${id} below its count`);
      }
      const sell = decodeSell(sellHex);
      const bid = decodeBid(bidHex);
      if (sell.lots === 0n && bid.lots === 0n) return null;
      return {
        id,
        round: await viewRound(chain, market, id, record, input.now),
        sell: sell.lots === 0n ? null : sell,
        bid: bid.lots === 0n ? null : bid,
      };
    }),
  );
  return {
    rounds: read.filter((r): r is EarlierRound => r !== null),
    unchecked: lowest - 1n,
  };
}
