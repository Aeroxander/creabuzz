/**
 * What an order sends (docs/v3-review/SECONDARY-LISTING-SPEC.md): the calls of one offer or one bid, all built
 * before the first is sent, and the one way a form puts them on the network.
 *
 * An offer or a bid is one action for the person, so it is one step: the approval the market needs and the order
 * itself go together, under one busy state and one failure, and the form closes only when the whole step landed.
 * Building every call first means an order that cannot be encoded (a count the contract would refuse) fails before
 * anything is signed, never after an approval is already on chain (Review-Proven Rules 1 and 5).
 *
 * Pure apart from the `sendBatch` it is handed, so `trading-orders.test.mjs` runs the real builders and the real
 * `placeOrder` against a recording sender.
 */

import { encodeApproveBounty } from "@creaton/core/launchpad/workBounty.ts";
import {
  encodeBid,
  encodeSell,
  type RoundView,
} from "@creaton/core/launchpad/secondary.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

import { bidHolds, sellHolds } from "./trading-copy.ts";

/** The market's own constants an order needs: where each token lives and what a lot is. */
export interface OrderFacts {
  lotSize: bigint;
  sharesToken: string;
  quoteToken: string;
}

/**
 * An offer's calls: the approval of exactly the Shares it escrows, then the offer. The offer is encoded first, so a
 * count the contract refuses throws before the approval is even built.
 */
export function sellCalls(input: {
  market: string;
  roundId: bigint;
  lots: bigint;
  level: number;
  facts: Pick<OrderFacts, "lotSize" | "sharesToken">;
}): SenderCall[] {
  const { market, roundId, lots, level, facts } = input;
  const sell = encodeSell(market, roundId, lots, level);
  const approve = encodeApproveBounty(market, sellHolds(lots, facts.lotSize));
  return [
    { to: facts.sharesToken, data: approve },
    { to: market, data: sell },
  ];
}

/**
 * A bid's calls. The market pulls exactly what the bid holds, so an approval that already covers it is left alone.
 * One that is partly there is cleared first: a token that refuses to move a non-zero allowance to another non-zero
 * one would otherwise fail every retry at the approval after one failed bid left some behind.
 */
export function bidCalls(input: {
  market: string;
  roundId: bigint;
  round: Pick<RoundView, "minPrice" | "step">;
  lots: bigint;
  level: number;
  /** What the quote token already lets the market take from this wallet. */
  allowance: bigint;
  facts: Pick<OrderFacts, "quoteToken">;
}): SenderCall[] {
  const { market, roundId, round, lots, level, allowance, facts } = input;
  const bid = encodeBid(market, roundId, lots, level);
  const holds = bidHolds(round, lots, level);
  const calls: SenderCall[] = [];
  if (allowance < holds) {
    if (allowance > 0n) {
      calls.push({
        to: facts.quoteToken,
        data: encodeApproveBounty(market, 0n),
      });
    }
    calls.push({
      to: facts.quoteToken,
      data: encodeApproveBounty(market, holds),
    });
  }
  calls.push({ to: market, data: bid });
  return calls;
}

/**
 * Put one order on the network as one step. `build` runs first and in full: a call it cannot encode is reported
 * through `fail` and nothing is sent, so no approval is left behind by an order that could never be placed. A send
 * that throws is reported the same way. True only when every call landed (the form then closes).
 */
export async function placeOrder(
  key: string,
  build: () => SenderCall[],
  sendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>,
  fail: (message: string) => void,
): Promise<boolean> {
  let calls: SenderCall[];
  try {
    calls = build();
  } catch (error) {
    fail(
      `That order couldn't be put together, so nothing was sent (${error instanceof Error ? error.message : String(error)}).`,
    );
    return false;
  }
  try {
    return await sendBatch(key, calls);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return false;
  }
}
