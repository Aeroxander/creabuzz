/**
 * The words and the form logic of weekly rounds (D131): whether rounds are on, where this week's round stands, one price
 * row, what an order gets, turning a typed price into the step it means, and the price history and what leaving pays now
 * (D147). Pure, so `rounds-copy.test.mjs` pins it.
 */

import { formatUnits, parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import type { ExitExchangePhase } from "./exit-exchange.ts";
import {
  escrowFor,
  type PastRound,
  type RoundGrid,
  type RoundHistory,
  type RoundView,
  sellerKeeps,
  stepAtLeast,
  stepAtMost,
} from "@creaton/core/launchpad/weeklyRounds.ts";

const USDC_DECIMALS = 6;

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** A round's day, without the time: when its bidding closed, which is when its orders set its price. */
const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

export const usdc = (units: bigint) =>
  `${formatUnits(units, USDC_DECIMALS)} USDC`;
export const shares = (units: bigint) => formatUnits(units, 18, 4);

/** Whether rounds are on for this DAO, in one sentence; null when its Shares move freely anyway. */
export function roundsStateLine(
  phase: ExitExchangePhase,
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
      return "Another contract was voted in to move Shares, so weekly rounds aren't on. Turn it off first, then start rounds.";
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

/**
 * The name of what a round trades. A holders' round moves Shares. A funding round sells whichever kind the DAO's funding
 * terms give buyers (the round's token): new Shares, which vote, or new non-voting shares (D177). When the DAO's Shares
 * address is unknown, plain "shares" covers both rather than claiming a vote the buyer may not get.
 */
export function roundUnit(
  round: Pick<RoundView, "funding" | "shares">,
  daoShares: string | null,
): "Shares" | "non-voting shares" | "shares" {
  if (!round.funding) return "Shares";
  if (!daoShares || !round.shares) return "shares";
  return round.shares.toLowerCase() === daoShares.toLowerCase()
    ? "Shares"
    : "non-voting shares";
}

/** What the round trades at its price, said plainly: settled, or as it would be if bidding ended now. */
export function clearingLine(
  round: Pick<RoundView, "phase" | "clearing" | "floor" | "step"> & {
    funding?: boolean;
  },
  unit: "Shares" | "non-voting shares" | "shares" = round.funding
    ? "shares"
    : "Shares",
): string {
  const price = round.floor + BigInt(round.clearing.step) * round.step;
  if (round.clearing.volume === 0n) {
    return round.phase === "settled"
      ? "Nothing traded: everyone takes back theirs."
      : "Nothing would trade yet.";
  }
  // A funding round creates new ones for the project, of the kind `unit` names; a holders' round moves Shares that exist.
  const what = `${shares(round.clearing.volume)} ${round.funding ? `new ${unit}` : "Shares"} at ${usdc(price)} each`;
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

// ---- price history and leaving (D147) ----------------------------------------------------------------

/** The round's own floor chip: fixed when the round opened, so it can differ from what leaving pays today. */
export function floorAtOpeningText(floor: bigint, unit: "Share" | "share") {
  return `Floor at opening: ${usdc(floor)} a ${unit}`;
}

/** What leaving pays per whole Share now, after the exit fee the exit itself would charge (zero while under notice). */
export function leavingPays(floorNow: bigint, exitFeeBps: bigint): bigint {
  return floorNow - (floorNow * exitFeeBps) / 10_000n;
}

const percent = (bps: bigint) => {
  const whole = bps / 100n;
  const rest = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return rest ? `${whole}.${rest}` : `${whole}`;
};

/** "Leaving now pays about X USDC a Share", saying when a fee applies. */
export function leavingLine(floorNow: bigint, exitFeeBps: bigint): string {
  const pays = usdc(leavingPays(floorNow, exitFeeBps));
  return exitFeeBps > 0n
    ? `Leaving now pays about ${pays} a Share, after the ${percent(exitFeeBps)}% exit fee.`
    : `Leaving now pays about ${pays} a Share.`;
}

/** The last price holders traded at, with its round and date, so an older trade never reads as today's price. */
export function lastTradeLine(
  history: Pick<RoundHistory, "lastTrade" | "complete">,
): string {
  const trade = history.lastTrade;
  if (trade) {
    return `Last trade: ${shares(trade.volume)} Shares at ${usdc(trade.price)} each, round ${trade.id} (${day(trade.closesAt)}).`;
  }
  // Only when every round was read is "yet" true; otherwise the search stopped short of the oldest.
  return history.complete ? "No trades yet." : "No trades in recent rounds.";
}

/** One finished round in the history: its date, and a price and amount only when something traded. */
export function historyRow(round: PastRound): {
  date: string;
  price: string | null;
  amount: string | null;
  note: string | null;
} {
  const date = day(round.closesAt);
  switch (round.outcome) {
    case "traded":
      return {
        date,
        price: usdc(round.price),
        amount: `${shares(round.volume)} Shares`,
        note: null,
      };
    case "nothing":
      return { date, price: null, amount: null, note: "Nothing traded" };
    case "void":
      return {
        date,
        price: null,
        amount: null,
        note: "Not settled, everything returned",
      };
  }
}

/** The Offer Shares form: what a seller keeps at their price, beside what leaving pays now. */
export function offerPlanLine(keepsEach: bigint, leavingEach: bigint | null) {
  const keeps = `If the round settles there, you keep ${usdc(keepsEach)} a Share after the treasury's cut. A higher price pays you more; below it, nothing sells.`;
  return leavingEach === null
    ? keeps
    : `${keeps} Leaving now pays about ${usdc(leavingEach)} a Share.`;
}
