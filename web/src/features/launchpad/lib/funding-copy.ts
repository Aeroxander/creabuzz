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
      return "This project sells no new units. A vote on the Decisions tab can publish funding terms: what buyers get, and the most it can ever sell.";
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

/** How much has been sold of the most that can ever be. */
export const soldLine = (view: FundingTermsView) =>
  `${units(view.sold)} of at most ${units(view.cap)} sold`;

/** A cap typed in whole units. */
export function capPlan(text: string): { problem: string } | { cap: bigint } {
  try {
    const cap = parseUnits(text, 18, "amount", "The most that can be sold");
    return cap > 0n
      ? { cap }
      : { problem: "The most that can be sold must be above zero." };
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
