/**
 * The words and the form logic of sales between members (N5): where sales stand, one offer in a line, what leaving pays
 * beside it, and turning the seller's form into the terms they sign. Pure, so `matched-exit-copy.test.mjs` pins it.
 */

import { formatUnits, parseUnits } from "./dao-actions.ts";
import type {
  ExitOffer,
  ExitOfferTerms,
  ExitSalesPhase,
} from "./matched-exit.ts";

const WAD = 10n ** 18n;
const USDC_DECIMALS = 6;
const DAY = 86_400;
/** The longest an offer can last, in days. */
export const MAX_OFFER_DAYS = 90;

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const usdc = (units: bigint) => `${formatUnits(units, USDC_DECIMALS)} USDC`;
const shares = (units: bigint) => formatUnits(units, 18, 4);

/** Where sales stand, in one sentence; null when the Shares are not locked (they move like any token, so nothing to say). */
export function salesStateLine(
  phase: ExitSalesPhase,
  opensAt: number | null,
): string | null {
  switch (phase) {
    case "unlocked":
      return null;
    case "off":
      return "Members can't sell Shares to each other here yet. A vote on the Decisions tab can allow it, and sales can start 30 days after it passes.";
    case "announced":
      return opensAt
        ? `A vote allowed sales between members. They can start on ${date(opensAt)}.`
        : "A vote allowed sales between members. They can start 30 days after it passed.";
    case "ready":
      return "A vote allowed sales between members, and the 30 days are over. Anyone can switch them on.";
    case "on":
      return "Members who want out can offer Shares at a price they choose, and anyone who wants in can buy them. The money goes to the seller, not the project.";
    case "other":
      return "This DAO named an exchange this app doesn't know, so sales there aren't shown here.";
  }
}

/** The price of one whole Share, in USDC base units, rounded down. */
export function pricePerShare(offer: Pick<ExitOffer, "price" | "amount">) {
  return (offer.price * WAD) / offer.amount;
}

/** One offer in a line: how many, for how much, from whom, until when. */
export function offerLine(offer: ExitOffer, seller: string): string {
  return `${shares(offer.amount)} Shares for ${usdc(offer.price)} (${usdc(pricePerShare(offer))} each), from ${seller}, until ${date(offer.expiry)}.`;
}

/** What leaving pays per Share right now, or null when it can't be said. */
export function leavingLine(perShare: bigint | null): string | null {
  if (perShare === null) return null;
  return perShare === 0n
    ? "Leaving pays no USDC right now."
    : `Leaving pays about ${usdc(perShare)} per Share right now.`;
}

export interface SellInput {
  amountText: string;
  /** USDC for one whole Share. */
  priceText: string;
  daysText: string;
  /** Shares the seller can sell: what they hold, less what a lock still holds back. */
  free: bigint;
  chainTime: number;
  /** This browser's clock in milliseconds: offer numbers rise with it, so "cancel all" can cover every earlier one. */
  nowMs: number;
  /** The lowest offer number the exchange still takes from this seller. */
  minNonce: bigint;
  chainId: number;
  exchange: string;
  sharesToken: string;
  seller: string;
}

/** The terms the seller signs, and the total buyers pay; or the sentence that says what to fix. */
export function composeSellOffer(
  input: SellInput,
): { terms: ExitOfferTerms; total: bigint } | { problem: string } {
  let amount: bigint;
  let each: bigint;
  try {
    amount = parseUnits(input.amountText, 18, "amount", "The number of Shares");
    each = parseUnits(input.priceText, USDC_DECIMALS, "price", "The price");
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  if (amount === 0n) return { problem: "Give how many Shares to sell." };
  if (input.free === 0n) {
    return {
      problem:
        "You have no Shares you can sell here. Shares still locked to work can't be sold.",
    };
  }
  if (amount > input.free) {
    return {
      problem: `You can sell up to ${shares(input.free)} Shares. Shares still locked to work can't be sold.`,
    };
  }
  const total = (each * amount) / WAD;
  if (total === 0n) {
    return { problem: "The price is too small to pay in USDC." };
  }
  const days = Number(input.daysText.trim());
  if (
    !/^\d{1,3}$/.test(input.daysText.trim()) ||
    days < 1 ||
    days > MAX_OFFER_DAYS
  ) {
    return {
      problem: `Say how many days the offer lasts, from 1 to ${MAX_OFFER_DAYS}.`,
    };
  }
  const fromClock = BigInt(Math.floor(input.nowMs));
  return {
    terms: {
      chainId: input.chainId,
      exchange: input.exchange,
      shares: input.sharesToken,
      seller: input.seller,
      amount,
      price: total,
      expiry: input.chainTime + days * DAY,
      nonce: fromClock > input.minNonce ? fromClock : input.minNonce,
    },
    total,
  };
}

/** The number that cancels every offer of a seller's below it: one past the highest they made. */
export function cancelAllNonce(mine: readonly ExitOffer[]): bigint | null {
  if (mine.length === 0) return null;
  return mine.reduce((top, o) => (o.nonce > top ? o.nonce : top), 0n) + 1n;
}
