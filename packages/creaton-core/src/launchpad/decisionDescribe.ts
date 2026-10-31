/**
 * Describe any decision the app knows how to compose, in plain words: the single-call actions (`daoActions.ts`) and the
 * decisions that open or close trading, sales between members, payouts and funding terms. A call this module did not
 * write is described as what it is not known to be, so the words never say more than the calls do.
 */

import {
  type ActionDescription,
  type DescribeContext,
  describeAction,
} from "./daoActions.ts";
import { describeFunding } from "./fundingTerms.ts";
import { describeExitSales } from "./matchedExit.ts";
import { describePayouts } from "./payouts.ts";
import { describeTrading } from "./tradingActions.ts";

/** Describe a proposal's action: one of the single-call actions, a list of steps, or what it is not known to be. */
export function describeDecision(
  action: { to: string; data: string },
  ctx: DescribeContext = {},
): ActionDescription {
  const trading = describeTrading(action, ctx);
  if (trading) return trading;
  const sales = describeExitSales(action, ctx);
  if (sales) return sales;
  const payouts = describePayouts(action, ctx);
  if (payouts) return payouts;
  const funding = describeFunding(action, ctx);
  if (funding) return funding;
  return describeAction(action, ctx);
}
