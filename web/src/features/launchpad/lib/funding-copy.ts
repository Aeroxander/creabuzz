/**
 * The words and the form logic of funding terms (D133): where they stand, what buyers get, how much is sold, and turning
 * a typed cap or sale into the numbers a vote carries. Pure, so `funding-copy.test.mjs` pins it.
 */

import { formatUnits, parseUnits } from "./dao-actions.ts";
import {
  type FundingPhase,
  type FundingTermsView,
  unsoldOfTranche,
} from "./funding-terms.ts";

const USDC_DECIMALS = 6;
const DAY = 86_400;
/** The longest a sale can be open for, in days. */
export const MAX_SALE_DAYS = 365;

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const usdc = (units: bigint) => `${formatUnits(units, USDC_DECIMALS)} USDC`;
export const units = (u: bigint) => formatUnits(u, 18, 4);

/** What buyers get, in a few words. */
export const instrumentLine = (asShares: boolean) =>
  asShares ? "Buyers get Shares, with a vote" : "Buyers get Loot, with no vote";

/** Where the terms stand, in one sentence. */
export function fundingStateLine(
  phase: FundingPhase,
  view: FundingTermsView | null,
): string {
  switch (phase) {
    case "none":
      return "This project sells no new units. A vote on the Decisions tab can publish funding terms: what buyers get, and a funding limit.";
    case "notice":
      return `Funding terms were published. Sales can start from ${date(view?.activeFrom ?? 0)}.`;
    case "ready":
      return "Funding terms are in place, and no sale is open. A vote opens one.";
    case "selling": {
      const t = view?.tranche;
      if (!t) return "A sale is open.";
      return `On sale for the project: ${units(unsoldOfTranche(view as FundingTermsView))} new units at ${usdc(t.leastPrice)} each or more, until ${date(t.expiry)}.`;
    }
  }
}

/** How much has been sold of the current authorised funding limit (a later vote can raise it). */
export const soldLine = (view: FundingTermsView) =>
  `${units(view.sold)} sold of a current funding limit of ${units(view.cap)}`;

/**
 * What a buyer should know before paying, about a contributor project: the things that differ from a fundraising
 * project's promises, each in one line.
 */
export function beforeYouBuy(view: FundingTermsView): string[] {
  return [
    "The funding limit is the current one: a later vote can raise it, with 30 days' notice.",
    "Contributors can still be awarded new Shares for reviewed work, with no yearly limit.",
    "Shares already earned can leave with part of the money raised, as yours can.",
    "This project's team has no milestone locks.",
    view.asShares
      ? "You get Shares, with a vote."
      : "You get Loot: the same part of the treasury and payouts as a Share, but no vote. For now you can leave with it at any time; selling it to a new buyer in a round comes later.",
  ];
}

/** A cap typed in whole units. */
export function capPlan(text: string): { problem: string } | { cap: bigint } {
  try {
    const cap = parseUnits(text, 18, "amount", "The funding limit");
    return cap > 0n
      ? { cap }
      : { problem: "The funding limit must be above zero." };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** A sale typed as how many units, the least price a unit, and how many days it stays open. */
export function salePlan(
  quantityText: string,
  priceText: string,
  daysText: string,
  chainTime: number,
  room: bigint,
):
  | { problem: string }
  | { quantity: bigint; leastPrice: bigint; expiry: number } {
  let quantity: bigint;
  let leastPrice: bigint;
  try {
    quantity = parseUnits(quantityText, 18, "amount", "How many units");
    leastPrice = parseUnits(
      priceText,
      USDC_DECIMALS,
      "amount",
      "The least price",
    );
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  if (quantity <= 0n) return { problem: "Sell at least some units." };
  if (leastPrice <= 0n)
    return { problem: "The least price must be above zero." };
  if (quantity > room) {
    return { problem: `The terms allow ${units(room)} more units at most.` };
  }
  const days = Number(daysText.trim());
  if (!Number.isInteger(days) || days < 1 || days > MAX_SALE_DAYS) {
    return { problem: `Keep the sale open for 1 to ${MAX_SALE_DAYS} days.` };
  }
  return { quantity, leastPrice, expiry: chainTime + days * DAY };
}
