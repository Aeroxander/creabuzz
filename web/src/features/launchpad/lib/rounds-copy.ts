/**
 * The words and the form logic of weekly rounds (D131): whether rounds are on, where this week's round stands, one price
 * row, what an order gets, and turning a typed price into the step it means. Pure, so `rounds-copy.test.mjs` pins it.
 */

import { formatUnits, parseUnits } from "./dao-actions.ts";
import type { ExitSalesPhase } from "./matched-exit.ts";
import {
  escrowFor,
  type RoundGrid,
  type RoundView,
  sellerKeeps,
  stepAtLeast,
  stepAtMost,
} from "./weekly-rounds.ts";

const USDC_DECIMALS = 6;

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const usdc = (units: bigint) =>
  `${formatUnits(units, USDC_DECIMALS)} USDC`;
export const shares = (units: bigint) => formatUnits(units, 18, 4);

/** Whether rounds are on for this DAO, in one sentence; null when its Shares move freely anyway. */
export function roundsStateLine(
  phase: ExitSalesPhase,
  opensAt: number | null,
): string | null {
  switch (phase) {
    case "unlocked":
      return null;
    case "off":
      return "This project has no weekly rounds yet. A vote on the Decisions tab can start them, 30 days after it passes.";
    case "announced":
      return opensAt
        ? `A vote started weekly rounds. They can be switched on from ${date(opensAt)}.`
        : "A vote started weekly rounds. They can be switched on 30 days after it passed.";
    case "ready":
      return "A vote started weekly rounds, and the 30 days are over. Anyone can switch them on.";
    case "on":
      return "Once a week, members who want out are matched with people who want in, at one price, never below what leaving pays.";
    case "other":
      return "This project sells Shares between members another way, so weekly rounds aren't on.";
  }
}

/** Where a round stands, in one sentence with its deadline. */
export function roundStatusLine(
  round: Pick<RoundView, "phase" | "closesAt">,
  settleBy: number,
): string {
  switch (round.phase) {
    case "bidding":
      return `Taking offers and bids until ${date(round.closesAt)}.`;
    case "settling":
      return `Bidding is over. Anyone can settle it until ${date(settleBy)}.`;
    case "settled":
      return "Settled. Everyone collects their own result.";
    case "void":
      return "Nobody settled it in time, so everyone takes back what they put in.";
  }
}

/** What the round trades at its price, said plainly: settled, or as it would be if bidding ended now. */
export function clearingLine(
  round: Pick<RoundView, "phase" | "clearing" | "floor" | "step"> & {
    funding?: boolean;
  },
): string {
  const price = round.floor + BigInt(round.clearing.step) * round.step;
  if (round.clearing.volume === 0n) {
    return round.phase === "settled"
      ? "Nothing traded: everyone takes back theirs."
      : "Nothing would trade yet.";
  }
  // A funding round creates new units for the project; a holders' round moves Shares that exist.
  const what = `${shares(round.clearing.volume)} ${round.funding ? "new units" : "Shares"} at ${usdc(price)} each`;
  if (round.phase === "settled") {
    return round.funding
      ? `${what} were sold for the project.`
      : `${what} changed hands.`;
  }
  return `If bidding ended now: ${what}.`;
}

/** A seller's form: the step their lowest price means, and what they keep per Share at it after the treasury's cut. */
export function sellPlan(
  grid: RoundGrid,
  amountText: string,
  priceText: string,
  free: bigint,
  isDao: boolean,
): { problem: string } | { amount: bigint; step: number; keepsEach: bigint } {
  let amount: bigint;
  let price: bigint;
  try {
    amount = parseUnits(amountText, 18, "amount", "How many Shares");
    price = parseUnits(priceText, USDC_DECIMALS, "amount", "The lowest price");
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  if (amount > free) {
    return { problem: `You can offer up to ${shares(free)} Shares.` };
  }
  const step = stepAtLeast(grid, price);
  if (step === null)
    return { problem: "That price is above this round's highest." };
  if (isDao && step < 2) {
    return {
      problem: "The DAO sells at least 2% above what leaving pays.",
    };
  }
  const at = grid.floor + BigInt(step) * grid.step;
  return { amount, step, keepsEach: sellerKeeps(grid, at) };
}

/** A buyer's form: the step their highest price means, and the money the bid holds until the round settles. */
export function bidPlan(
  grid: RoundGrid,
  amountText: string,
  priceText: string,
  balance: bigint,
): { problem: string } | { amount: bigint; step: number; holds: bigint } {
  let amount: bigint;
  let price: bigint;
  try {
    amount = parseUnits(amountText, 18, "amount", "How many Shares");
    price = parseUnits(priceText, USDC_DECIMALS, "amount", "The highest price");
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  const step = stepAtMost(grid, price);
  if (step === null) {
    return {
      problem: `Bid at least ${usdc(grid.floor)} a Share: what leaving pays.`,
    };
  }
  const holds = escrowFor(amount, grid.floor + BigInt(step) * grid.step);
  if (holds > balance) {
    return {
      problem: `This bid holds ${usdc(holds)}; you have ${usdc(balance)}.`,
    };
  }
  return { amount, step, holds };
}
