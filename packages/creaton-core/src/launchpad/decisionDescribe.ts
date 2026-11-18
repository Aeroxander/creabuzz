/**
 * Describe any decision the app knows how to compose, in plain words: the single-call actions (`daoActions.ts`) and the
 * decisions that open or close trading, weekly rounds, payouts and funding terms, and changes to the voting
 * settings, which this app never composes but must warn about. A call this module did not
 * write is described as what it is not known to be, so the words never say more than the calls do.
 */

import {
  type ActionDescription,
  type DescribeContext,
  describeAction,
} from "./daoActions.ts";
import { describeFunding } from "./fundingTerms.ts";
import { describeExitExchange } from "./exitExchange.ts";
import { describePayouts } from "./payouts.ts";
import { describeTrading } from "./tradingActions.ts";
import { describeVotingRules } from "./votingRules.ts";

/** What is said of a decision that is not a plain call without ETH, or null when it is one. */
function describePlainOnly(action: {
  to: string;
  data: string;
  op?: number;
  value?: bigint;
}): ActionDescription | null {
  const lines: string[] = [];
  if (action.op !== undefined && action.op !== 0) {
    lines.push(
      "It would run another contract's code as the DAO itself, with all the DAO's power, rather than make an ordinary call.",
    );
  }
  if (action.value !== undefined && action.value > 0n) {
    lines.push("It would also send ETH from the DAO with the call.");
  }
  if (lines.length === 0) return null;
  return {
    kind: "unknown",
    title: "An action this app does not know how to describe",
    lines: [
      ...lines,
      `A call to ${action.to}, ${action.data.slice(0, 10)} (${Math.max(0, (action.data.length - 2) / 2)} bytes)`,
    ],
  };
}

/**
 * Describe a proposal's action: one of the single-call actions, a list of steps, or what it is not known to be.
 *
 * Every describer reads the calldata of a plain call that carries no ETH, which is all this app ever composes. A
 * decision that would instead run code as the DAO itself, or send ETH along, is not that call whatever its calldata
 * looks like, so it is never put in the words of one.
 */
export function describeDecision(
  action: { to: string; data: string; op?: number; value?: bigint },
  ctx: DescribeContext = {},
): ActionDescription {
  const plain = describePlainOnly(action);
  if (plain) return plain;
  const trading = describeTrading(action, ctx);
  if (trading) return trading;
  const exchange = describeExitExchange(action, ctx);
  if (exchange) return exchange;
  const payouts = describePayouts(action, ctx);
  if (payouts) return payouts;
  const funding = describeFunding(action, ctx);
  if (funding) return funding;
  const voting = describeVotingRules(action, ctx);
  if (voting) return voting;
  return describeAction(action, ctx);
}
