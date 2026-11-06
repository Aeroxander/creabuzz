/**
 * Words for the exchange slot on a DAO's Shares (the old weekly rounds, D131, used it): while the Shares are locked, only
 * the exchange the DAO named by vote passes the lock. A vote announces it (`announceExitExchange`) and a vote turns it
 * off at once (`clearExitExchange`). The old weekly rounds contract is deprecated (D185) and this app no longer offers
 * it, so a vote that names any exchange is described as "another contract", and the one way left to act is to turn the
 * exchange off. Pure; the selectors are pinned to `cast sig` in `exitExchange.test.mjs`.
 */

import {
  type ActionDescription,
  type DecisionDraft,
  DecisionInputError,
  type DescribeContext,
} from "./daoActions.ts";
import { selectorOf } from "./evmAbi.ts";
import { encodeCall0 } from "./work.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The Shares' side: naming the exchange and turning it off. */
export const EXIT_EXCHANGE_SIGNATURES = {
  announce: "announceExitExchange(address)",
  clear: "clearExitExchange()",
} as const;

// ---- decisions ----------------------------------------------------------------------------------

function sharesAddress(value: string): string {
  if (!ADDRESS_RE.test(value.trim())) {
    throw new DecisionInputError(
      "sharesToken",
      "The project's Shares are not an address.",
    );
  }
  return value.trim().toLowerCase();
}

/**
 * The vote that turns the exchange off, whichever contract it names: at once, and turning one on again needs another
 * 30 days. The call is the same whichever contract is named.
 */
export function stopExchangeDecision(input: {
  sharesToken: string;
}): DecisionDraft {
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeCall0(EXIT_EXCHANGE_SIGNATURES.clear),
    lane: "unrestricted",
    title: "Turn off Shares sales",
    lines: [
      "No new weekly round opens, and no other contract the project voted in can move Shares. Members can still leave with their part of the treasury.",
      "Turning sales on again needs a new vote and another 30 days.",
    ],
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An exchange decision in words, or null when the action is not one aimed at this project's Shares. */
export function describeExitExchange(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  if (!ctx.projectToken || !same(action.to, ctx.projectToken)) return null;
  const data = action.data.toLowerCase();
  const sel = data.slice(0, 10);
  if (
    sel === selectorOf(EXIT_EXCHANGE_SIGNATURES.clear) &&
    data.length === 10
  ) {
    const draft = stopExchangeDecision({ sharesToken: action.to });
    return { kind: "trading", title: draft.title, lines: draft.lines };
  }
  if (
    sel === selectorOf(EXIT_EXCHANGE_SIGNATURES.announce) &&
    data.length === 74 &&
    /^0{24}/.test(data.slice(10, 34))
  ) {
    const exchange = `0x${data.slice(34, 74)}`;
    const named = ctx.label ? ctx.label(exchange) : exchange;
    return {
      kind: "trading",
      title: "Let another contract move Shares in 30 days",
      lines: [
        `This names ${named} as the exchange, and it is not the one this app knows. It could move the Shares of anyone who allows it to.`,
        "It can be switched on 30 days after this runs, and a later vote can turn it off at once.",
      ],
    };
  }
  return null;
}
