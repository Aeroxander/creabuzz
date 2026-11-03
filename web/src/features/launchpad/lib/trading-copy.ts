/**
 * The words and the form logic of the secondary market
 * (docs/v3-review/SECONDARY-LISTING-SPEC.md): whether a DAO has a market at
 * all, whether it has opened a listing, what its listing trades at, where the
 * latest round stands, what one lot costs at a grid step, what a typed price
 * means, and what a wallet is owed once a round is over.
 *
 * Pure, so `trading-copy.test.mjs` pins every sentence without a browser. The
 * adapter (`packages/creaton-core/src/launchpad/secondary.ts`) is the only
 * source of what a market says: a read it could not complete arrives here as
 * `unreadable`, and this module never turns that into "no market" — a question
 * the node did not answer is not evidence that the DAO has none.
 *
 * Units: a price is quote base units per whole lot, and a lot is the market's
 * own `lotSize` Shares base units. The quote token is whatever the DAO's kit was
 * launched with, so its own decimals and symbol are arguments here
 * (`QuoteUnits`), never a constant: a price written at a guessed scale is wrong
 * by the factor the guess is wrong by, which is the same defect as a read that
 * did not complete (Review-Proven Rule 1).
 */

import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  lotPriceAt,
  type Listing,
  type RoundView,
  SECONDARY_EVERY,
  type SecondaryMarketRead,
  type WalletView,
} from "@creaton/core/launchpad/secondary.ts";

/** What every price is written in: the market's own quote token, as the token names itself. */
export interface QuoteUnits {
  /** The token's decimals: one whole unit is `10 ** quoteDecimals` base units. */
  quoteDecimals: number;
  /** The token's own symbol, as it answers `symbol()` (e.g. "USDC"). */
  quoteSymbol: string;
}

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** A round's day without the time: when its offers closed, which is when its price was set. */
const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

/**
 * Quote base units as money at the token's own scale, keeping every decimal it
 * can name: "1 USDC" at six, "1 FQ" at eighteen. The fraction is cut at the
 * token's own decimals and its trailing zeros trimmed, so a whole price reads as
 * a whole number however many decimals the token has.
 */
export const money = (units: bigint, quote: QuoteUnits) =>
  `${formatUnits(units, quote.quoteDecimals, quote.quoteDecimals)} ${quote.quoteSymbol}`;

/** Whole lots, in words: "1 lot", "3 lots". */
export const lots = (count: bigint) =>
  `${count.toString()} ${count === 1n ? "lot" : "lots"}`;

/** Shares base units, trimmed: what one lot or one order holds. */
export const shareUnits = (units: bigint) => formatUnits(units, 18, 4);

/** This build names no market factory on this network, so there is nothing to read. */
export function factoryMissingLine(): string {
  return "Trading isn't set up on this network, so it can't be shown here.";
}

/**
 * The read did not complete. Never "no market": a failed read says only that we
 * could not see the factory's answer.
 */
export function unreadableLine(): string {
  return "The market couldn't be read just now, so this page can't say whether this DAO has one. Reload to try again.";
}

/**
 * The market was found but its price token would not say its decimals or its
 * symbol. Every price would then be printed at a guessed scale, so none is
 * printed at all: this is the same refusal as any other read we do not have.
 */
export function tokenUnreadableLine(): string {
  return "The market's price token couldn't be read just now, so no price can be shown. Reload to try again.";
}

/** The listing's terms in words: the range a lot may trade in, and how many steps divide it. */
export function listingTermsLine(
  listing: Pick<Listing, "minPrice" | "maxPrice" | "levels">,
  quote: QuoteUnits,
): string {
  const steps = `${listing.levels} ${listing.levels === 1 ? "step" : "steps"}`;
  return `from ${money(listing.minPrice, quote)} to ${money(listing.maxPrice, quote)} a lot, in ${steps}`;
}

/** Where the latest round stands, said plainly; nothing traded when it settled or went void with no orders. */
export function roundLine(
  round: Pick<
    RoundView,
    | "phase"
    | "closesAt"
    | "settleDeadline"
    | "asked"
    | "wanted"
    | "price"
    | "minPrice"
    | "step"
  >,
  quote: QuoteUnits,
): string {
  switch (round.phase) {
    case "bidding":
      return `Offers and bids close ${date(round.closesAt)}.`;
    case "settling":
      return `Bidding is over. Anyone can settle it until ${date(round.settleDeadline)}.`;
    case "settled":
      // Nothing was offered or bid: a price would be a claim about a trade nobody made.
      return round.asked === 0n && round.wanted === 0n
        ? "Settled. Nothing traded: everyone takes back theirs."
        : `Settled at ${money(lotPriceAt(round, round.price), quote)} a lot, after offers closed ${day(round.closesAt)}. Everyone collects their own result.`;
    case "void":
      return "Nobody settled it in time: nothing traded, so everyone takes back what they put in.";
    case "none":
      return "No round has opened yet.";
  }
}

/** What one lot costs at grid step `level` of this round's frozen grid. */
export function lotPriceLine(
  round: Pick<RoundView, "minPrice" | "step" | "levels">,
  level: number,
  quote: QuoteUnits,
): string {
  return `${money(lotPriceAt(round, level), quote)} a lot at step ${level} of ${round.levels}`;
}

/** What one lot is, so a price per lot means something: the market's own bundle of Shares. */
export function lotSizeLine(lotSize: bigint): string {
  return `A lot is ${shareUnits(lotSize)} Shares.`;
}

/** The listing's two concrete units: how big a lot is, and how far apart the grid's steps sit. */
export function listingDetailLine(
  listing: Pick<Listing, "minPrice" | "maxPrice" | "levels">,
  lotSize: bigint,
  quote: QuoteUnits,
): string {
  const size = lotSizeLine(lotSize);
  if (listing.levels <= 0) return size;
  const step = (listing.maxPrice - listing.minPrice) / BigInt(listing.levels);
  return `${size} Each step is ${money(step, quote)} apart.`;
}

/** When the market allows its next round: a week after the last one opened. A chip carries no full stop. */
export function nextRoundChip(opensAt: number): string {
  return `Next round from ${date(opensAt)}`;
}

/** The same words as a sentence. */
export function nextRoundLine(opensAt: number): string {
  return `${nextRoundChip(opensAt)}.`;
}

/**
 * What trading is doing, in one or two sentences. The three states that matter
 * are told apart: no market for this DAO, a market with no listing, and a
 * listing that is on. An unreadable read says only that it could not be read.
 *
 * `quote` is the market's own price token, and null when it could not be read:
 * a listing that is on cannot state its terms without it, so that case is said
 * as the unreadable read it is rather than printed at a guessed scale.
 */
export function tradingStateLine(
  read: SecondaryMarketRead,
  now: number,
  quote: QuoteUnits | null,
): string {
  if (read.kind === "unreadable") return unreadableLine();
  if (read.kind === "absent") {
    return "This DAO has no secondary market. A DAO made before the market existed, or made without one, has none.";
  }
  const { listing, round } = read;
  if (!listing.enabled) {
    return "Trading is off: the DAO has no open listing. Opening one is the DAO's decision.";
  }
  if (quote === null) return unreadableLine();
  const terms = `Trading is on: ${listingTermsLine(listing, quote)}.`;
  const phase =
    round === null
      ? "No round has opened yet."
      : round.phase === "bidding"
        ? "A round is taking offers and bids now."
        : round.phase === "settling"
          ? "A round is waiting to be settled."
          : round.phase === "settled"
            ? "The latest round has settled."
            : "The latest round went void, so everyone takes back what they put in.";
  const next =
    round !== null &&
    (round.phase === "settled" || round.phase === "void") &&
    now < round.opensAt + SECONDARY_EVERY
      ? ` ${nextRoundLine(round.opensAt + SECONDARY_EVERY)}`
      : "";
  return `${terms} ${phase}${next}`;
}

/** A seller's form: the whole lots they offer, and the lowest step their price means. */
export function sellPlan(
  round: Pick<RoundView, "minPrice" | "step" | "levels">,
  lotsText: string,
  priceText: string,
  quote: QuoteUnits,
): { problem: string } | { lots: bigint; level: number } {
  const whole = wholeLots(lotsText);
  if ("problem" in whole) return whole;
  let price: bigint;
  try {
    price = priceOf(priceText, "The lowest price", quote.quoteDecimals);
  } catch (error) {
    return { problem: messageOf(error) };
  }
  const level = stepAtLeast(round, price);
  if (level === null) {
    return { problem: "That price is above this round's highest." };
  }
  return { lots: whole.lots, level };
}

/** A buyer's form: the whole lots they bid for, and the highest step their price means. */
export function bidPlan(
  round: Pick<RoundView, "minPrice" | "step" | "levels">,
  lotsText: string,
  priceText: string,
  quote: QuoteUnits,
): { problem: string } | { lots: bigint; level: number } {
  const whole = wholeLots(lotsText);
  if ("problem" in whole) return whole;
  let price: bigint;
  try {
    price = priceOf(priceText, "The highest price", quote.quoteDecimals);
  } catch (error) {
    return { problem: messageOf(error) };
  }
  const level = stepAtMost(round, price);
  if (level === null) {
    return {
      problem: `Bid at least ${money(round.minPrice, quote)} a lot: this round's lowest.`,
    };
  }
  return { lots: whole.lots, level };
}

/** The money a bid holds until the round settles: whole lots at the step's price. */
export function bidHolds(
  round: Pick<RoundView, "minPrice" | "step">,
  lots: bigint,
  level: number,
): bigint {
  return lots * lotPriceAt(round, level);
}

/** The Shares an offer escrows until the round settles: whole lots of the market's own size. */
export function sellHolds(lots: bigint, lotSize: bigint): bigint {
  return lots * lotSize;
}

/**
 * The lowest step whose price is at or above `price` — a seller's floor. Null
 * when that is above the round's highest step.
 */
export function stepAtLeast(
  round: Pick<RoundView, "minPrice" | "step" | "levels">,
  price: bigint,
): number | null {
  const diff = price - round.minPrice;
  if (diff <= 0n) return 0;
  if (round.step <= 0n) return null;
  const level = (diff + round.step - 1n) / round.step;
  return level > BigInt(round.levels) ? null : Number(level);
}

/**
 * The highest step whose price is at or below `price` — a buyer's limit. Null
 * when that is below the round's lowest step.
 */
export function stepAtMost(
  round: Pick<RoundView, "minPrice" | "step" | "levels">,
  price: bigint,
): number | null {
  if (price < round.minPrice) return null;
  if (round.step <= 0n) return 0;
  const level = (price - round.minPrice) / round.step;
  return level > BigInt(round.levels) ? round.levels : Number(level);
}

/** What one side of a wallet's orders says, before and after the round's result. */
export function sellOrderLine(
  round: Pick<RoundView, "phase" | "minPrice" | "step">,
  sell: { lots: bigint; minStep: number; filled: bigint },
  quote: QuoteUnits,
): string {
  const at = money(lotPriceAt(round, sell.minStep), quote);
  const offer = `You offer ${lots(sell.lots)} at ${at} a lot or more.`;
  if (round.phase === "settled") {
    return `${offer} Sold: ${lots(sell.filled)} at the round's price.`;
  }
  if (round.phase === "void")
    return `${offer} The round went void, so they come back to you.`;
  return offer;
}

/** The buyer's side, said the same way. */
export function bidOrderLine(
  round: Pick<RoundView, "phase" | "minPrice" | "step">,
  bid: { lots: bigint; maxStep: number; filled: bigint; cancelled: boolean },
  quote: QuoteUnits,
): string {
  const at = money(lotPriceAt(round, bid.maxStep), quote);
  if (bid.cancelled) {
    return `You took back your bid for ${lots(bid.lots)} at up to ${at} a lot. The money is yours to collect.`;
  }
  const offer = `You bid for ${lots(bid.lots)} at up to ${at} a lot.`;
  if (round.phase === "settled") {
    return `${offer} Bought: ${lots(bid.filled)} at the round's price.`;
  }
  if (round.phase === "void") {
    return `${offer} The round went void, so your money comes back to you.`;
  }
  return offer;
}

/** What a round owes the wallet: Shares to collect, and money to collect. */
export interface ClaimDue {
  shares: bigint;
  quote: bigint;
}

/**
 * What this wallet can still collect from a round: its bought Shares, a void
 * round's own offer back, a seller's proceeds, a buyer's refund, a cancelled
 * bid's escrow. Zeroes while bidding is open, except for a bid already taken
 * back (the contract pays that refund whenever it is asked for).
 */
export function claimDue(
  round: Pick<RoundView, "phase" | "minPrice" | "step" | "price">,
  wallet: Pick<WalletView, "sell" | "bid">,
  lotSize: bigint,
): ClaimDue {
  const over = round.phase === "settled" || round.phase === "void";
  const { sell, bid } = wallet;
  if (!over && bid?.cancelled !== true) return { shares: 0n, quote: 0n };
  let shares = 0n;
  let quote = 0n;
  // A void round never settles, so its orders' escrow comes back by claim.
  if (round.phase === "void" && sell && !sell.escrowReturned) {
    shares += sell.lots * lotSize;
  }
  if (
    round.phase === "settled" &&
    bid &&
    !bid.sharesPaid &&
    bid.filled !== 0n
  ) {
    shares += bid.filled * lotSize;
  }
  if (sell && !sell.proceedsPaid && over) {
    quote += sell.filled * lotPriceAt(round, round.price);
  }
  if (bid && !bid.refundDone) {
    const escrow = bid.lots * lotPriceAt(round, bid.maxStep);
    const spent = bid.filled * lotPriceAt(round, round.price);
    quote += escrow - spent;
  }
  return { shares, quote };
}

/** Whole lots, or why the text is not a number of lots. */
function wholeLots(text: string): { lots: bigint } | { problem: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { problem: "Use a whole number of lots." };
  }
  const count = BigInt(trimmed);
  if (count === 0n)
    return { problem: "An order holds at least one whole lot." };
  return { lots: count };
}

/** A typed price as quote base units, or a thrown problem the form shows. */
function priceOf(text: string, what: string, decimals: number): bigint {
  const trimmed = text.trim();
  const parts = trimmed.split(".");
  if (
    parts.length > 2 ||
    !/^\d+$/.test(parts[0] ?? "") ||
    (parts[1] !== undefined && !/^\d+$/.test(parts[1])) ||
    (parts[1]?.length ?? 0) > decimals
  ) {
    throw new Error(
      `${what} must be a number with at most ${decimals} decimal places.`,
    );
  }
  return (
    BigInt(parts[0]) * 10n ** BigInt(decimals) +
    BigInt((parts[1] ?? "").padEnd(decimals, "0") || "0")
  );
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
