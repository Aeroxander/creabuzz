/**
 * What a backer's or a founder's step sends, all built before the first call is sent.
 *
 * A step is one action for the person, so it is one batch: the approval the pool needs and the buy go together, under
 * one busy state and one failure, and the form closes only when the whole step landed (`trading-orders.ts`'s `placeOrder`,
 * which these builders are made for). Building every call first means a step the contract would refuse for a reason this
 * file can see (an amount of nothing, an amount over what the wallet holds, a limit that is no limit) fails before
 * anything is signed, never after an approval is already on the network (Review-Proven Rules 1 and 5).
 *
 * Every trade carries a price limit and a deadline: the pool's own note says a large buy sent without a limit can be
 * sandwiched, and the app must always send one.
 *
 * Pure: `backing-orders.test.mjs` runs the real builders.
 */

import {
  type BuyQuote,
  encodeBuy,
  encodeLeave,
  encodeOpenPool,
  encodeOpenWithRound,
  encodePostMilestone,
  encodeRedeem,
  encodeResolveMilestone,
  encodeSeedFromAuction,
  encodeSell,
  type LeaveQuote,
  type PoolSnapshot,
  type QuoteFacts,
  type SellQuote,
  tradeDeadline,
  withSlippage,
} from "@creaton/core/launchpad/backing.ts";
import { encodeErc20Approve } from "@creaton/core/launchpad/evmCalls.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

import { money } from "./backing-copy.ts";

/** The price moves a person may allow, in basis points, and the one that is chosen first. */
export const SLIPPAGE_CHOICES: readonly { bps: number; label: string }[] = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 300, label: "3%" },
];
export const DEFAULT_SLIPPAGE_BPS = 100;

/** The clocks a deadline is set from. */
export interface Clocks {
  chainNow: number;
  browserNow: number;
}

/**
 * The first reason a buy cannot go, in words, or null. Said before anything is signed: an amount of nothing, more than
 * the wallet holds, more than the early limit allows, a quote that would give no units.
 */
export function buyIssue(input: {
  quoteIn: bigint | null;
  quote: BuyQuote | null;
  balance: bigint | null;
  snapshot: Pick<PoolSnapshot, "holderEarlyLeft">;
  token: QuoteFacts;
}): string | null {
  const { quoteIn, quote, balance, snapshot, token } = input;
  if (quoteIn === null || quoteIn <= 0n)
    return "Enter an amount above zero to put in.";
  if (balance !== null && quoteIn > balance)
    return `You hold ${money(balance, token)}, which is less than that. Put in less, or get more first.`;
  const early = snapshot.holderEarlyLeft;
  if (early !== null && quoteIn > early)
    return `While a project is new, one account can put in only a limited amount. You can put in up to ${money(early, token)} more now.`;
  if (quote !== null && quote.unitsOut <= 0n)
    return "That amount is too small to buy any units. Put in more.";
  return null;
}

/**
 * A buy's calls: the approval of exactly what is put in (cleared first when a smaller one is left over, for a token that
 * refuses to change one non-zero allowance into another), then the buy with its limit and deadline.
 */
export function buyCalls(input: {
  pool: string;
  token: string;
  quoteIn: bigint;
  quote: BuyQuote;
  /** What the pool may already take from this wallet. */
  allowance: bigint;
  slippageBps: number;
  clocks: Clocks;
}): SenderCall[] {
  const { pool, token, quoteIn, quote, allowance, slippageBps, clocks } = input;
  // Built first: a limit or a deadline that cannot be encoded throws before an approval exists.
  const buy = encodeBuy(
    quoteIn,
    withSlippage(quote.unitsOut, slippageBps),
    tradeDeadline(clocks.chainNow, clocks.browserNow),
  );
  const calls: SenderCall[] = [];
  if (allowance < quoteIn) {
    if (allowance > 0n)
      calls.push({ to: token, data: encodeErc20Approve(pool, 0n) });
    calls.push({ to: token, data: encodeErc20Approve(pool, quoteIn) });
  }
  calls.push({ to: pool, data: buy });
  return calls;
}

/** A sale's call. Units are not approved: the pool burns them itself. */
export function sellCalls(input: {
  pool: string;
  units: bigint;
  quote: SellQuote;
  slippageBps: number;
  clocks: Clocks;
}): SenderCall[] {
  return [
    {
      to: input.pool,
      data: encodeSell(
        input.units,
        withSlippage(input.quote.quoteOut, input.slippageBps),
        tradeDeadline(input.clocks.chainNow, input.clocks.browserNow),
      ),
    },
  ];
}

/** Leaving at the open milestone: all the wallet's units, and all of its held money back, with a limit. */
export function leaveCalls(input: {
  pool: string;
  quote: LeaveQuote;
  slippageBps: number;
  clocks: Clocks;
}): SenderCall[] {
  return [
    {
      to: input.pool,
      data: encodeLeave(
        withSlippage(input.quote.quoteOut, input.slippageBps),
        tradeDeadline(input.clocks.chainNow, input.clocks.browserNow),
      ),
    },
  ];
}

/** The founder's "post a milestone": the id of the public record it points at. */
export function postMilestoneCalls(
  pool: string,
  recordId: string,
): SenderCall[] {
  return [{ to: pool, data: encodePostMilestone(recordId) }];
}

/** Anyone's "settle": release the milestone whose time to leave is over, or close one nobody released. */
export function settleMilestoneCalls(pool: string): SenderCall[] {
  return [{ to: pool, data: encodeResolveMilestone() }];
}

/** Anyone's "settle the round": work out whether the opening round reached its minimum and open or close the pool. */
export function settleRoundCalls(pool: string): SenderCall[] {
  return [{ to: pool, data: encodeSeedFromAuction() }];
}

/** Exchange the round's tokens for units, all at once. */
export function redeemCalls(pool: string, amount: bigint): SenderCall[] {
  return [{ to: pool, data: encodeRedeem(amount) }];
}

/** The founder opens backing: now, or behind a fair round with a minimum (zero asks for the default). */
export function openBackingCalls(
  factory: string,
  dao: string,
  how: { kind: "now" } | { kind: "round"; minimum: bigint },
): SenderCall[] {
  return [
    {
      to: factory,
      data:
        how.kind === "now"
          ? encodeOpenPool(dao)
          : encodeOpenWithRound(dao, how.minimum),
    },
  ];
}
