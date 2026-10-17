/**
 * What one of a person's bids says about itself, in plain words.
 *
 * The bid row used to print the contract's own numbers (a maximum price in a fixed-point format, a "filled" count that is
 * zero again once the tokens were collected) and a status word like "Settled". Someone who had just collected their
 * tokens read "filled 0". This says what the bid is and what, if anything, is left to do, from the same status the
 * actions are gated on.
 *
 * Pure and alias-free: `bid-words.test.mjs` drives it under `node --test`.
 */

import { formatAtomic } from "./amounts.ts";

export type BidWordsStatus =
  | "active"
  | "outbid"
  | "ended"
  | "exited"
  | "claimable"
  | "settled";

/** What a bid status means for the person who made it. */
export const BID_SENTENCES: Record<BidWordsStatus, string> = {
  active: "Your bid is in and the sale is still running.",
  outbid:
    "The price rose above your highest price, so this bid has stopped filling. Take back what is left.",
  ended:
    "The sale has ended. Take back any unspent money, then collect your tokens.",
  exited:
    "Your unspent money is back with you. You can collect your tokens once the sale pays out.",
  claimable: "Your tokens are ready to collect.",
  settled: "Nothing is left to collect from this bid.",
};

/** The Q96 fixed-point scale a bid's amount is stored in. */
const Q96 = 96n;

/**
 * How much money the bid put in, as the sale shows it ("133,333 USDC"), or null when it cannot be said: no amount, or a
 * currency whose name and decimals are not known here (a custom token), where a made-up unit would mislead.
 */
export function bidAmountText(
  amountQ96: bigint,
  currency: { kind: string; symbol: string; decimals: number },
): string | null {
  if (currency.kind === "custom") return null;
  const amount = amountQ96 >> Q96;
  if (amount <= 0n) return null;
  return formatAtomic(amount, currency.decimals, {
    symbol: currency.symbol,
    maxFractionDigits: currency.decimals > 6 ? 4 : 2,
  });
}

/** One sentence for the row: what the bid put in, then what it means now. */
export function bidSummary(
  status: string,
  amountQ96: bigint,
  currency: { kind: string; symbol: string; decimals: number },
): string {
  const meaning =
    BID_SENTENCES[status as BidWordsStatus] ??
    "This bid is in a state this page does not recognise yet.";
  const amount = bidAmountText(amountQ96, currency);
  return amount ? `${amount} offered. ${meaning}` : meaning;
}
