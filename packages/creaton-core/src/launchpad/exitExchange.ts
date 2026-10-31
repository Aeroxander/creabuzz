/**
 * The exchange a DAO names on its Shares (weekly rounds, D131): while the Shares are locked, only the exchange the DAO
 * named by vote passes the lock. A vote announces it (`announceExitExchange`), anyone switches it on 30 days later
 * (`activateExitExchange`), and a vote turns it off at once (`clearExitExchange`). Every other check of the Shares still
 * applies, so Shares a lock still holds cannot be sold.
 *
 * Pure apart from the reader, whose chain is injected (`exitExchange.test.mjs` runs it against a fake one). The selectors
 * are pinned to `cast sig` in the same test.
 */

import {
  type ActionDescription,
  type DecisionDraft,
  DecisionInputError,
  type DescribeContext,
} from "./daoActions.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import { UNLOCK_NOTICE } from "./tradingActions.ts";
import { decodeAddress, decodeBool, decodeWord, encodeCall0 } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The Shares' side: naming the exchange, switching it on, turning it off, and reading where that stands. */
export const EXIT_EXCHANGE_SIGNATURES = {
  announce: "announceExitExchange(address)",
  activate: "activateExitExchange()",
  clear: "clearExitExchange()",
  exchange: "exitExchange()",
  pending: "pendingExitExchange()",
  announcedAt: "exitExchangeAnnouncedAt()",
  transfersLocked: "transfersLocked()",
} as const;

export const encodeActivateExitExchange = (): string =>
  encodeCall0(EXIT_EXCHANGE_SIGNATURES.activate);

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
 * The vote that names weekly rounds (D131) as the exchange: members who want out are matched with new buyers once a week
 * at one price. Rounds can be switched on 30 days after it runs, not before.
 */
export function allowRoundsDecision(input: {
  sharesToken: string;
  exchange: string;
}): DecisionDraft {
  if (!ADDRESS_RE.test(input.exchange.trim())) {
    throw new DecisionInputError(
      "exchange",
      "Weekly rounds are not set up on this network.",
    );
  }
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeFunctionData(
      EXIT_EXCHANGE_SIGNATURES.announce,
      ["address"],
      [input.exchange.trim().toLowerCase()],
    ),
    lane: "unrestricted",
    title: "Start weekly rounds in 30 days",
    lines: [
      "Once a week, members who want out are matched with people who want in, at one price, never below what leaving pays. The treasury keeps its money, and a fifth of a seller's gain above that goes to it.",
      "Rounds can be switched on 30 days after this runs, and not before. The contracts enforce the wait.",
      "Shares still locked to work can't be sold, anyone can still leave, and a later vote can turn rounds off at once.",
    ],
  };
}

/**
 * The vote that turns the exchange off, whichever contract it names: at once, and turning one on again needs another
 * 30 days. The words fit weekly rounds and an exchange this app does not know, since the call is the same for both.
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
    if (ctx.weeklyRounds && same(exchange, ctx.weeklyRounds)) {
      const draft = allowRoundsDecision({ sharesToken: action.to, exchange });
      return { kind: "trading", title: draft.title, lines: draft.lines };
    }
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

// ---- reads ---------------------------------------------------------------------------------------

/** Where the exchange stands for a DAO's Shares. */
export interface ExitExchangeRead {
  transfersLocked: boolean;
  /** The exchange that passes the lock, or null. */
  exchange: string | null;
  /** An exchange voted in and waiting for its 30 days, or null. */
  pending: string | null;
  /** When the pending exchange was announced (unix seconds), or 0. */
  announcedAt: number;
}

export async function readExitExchange(
  chain: Pick<WorkChain, "call">,
  shares: string,
): Promise<ExitExchangeRead> {
  if (!ADDRESS_RE.test(shares)) throw new Error("the Shares is not an address");
  const to = shares.toLowerCase();
  const [locked, exchange, pending, announcedAt] = await Promise.all([
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.transfersLocked)),
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.exchange)),
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.pending)),
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.announcedAt)),
  ]);
  const addressOrNull = (hex: string) => {
    const a = decodeAddress(hex);
    return a === ZERO ? null : a;
  };
  return {
    transfersLocked: decodeBool(locked),
    exchange: addressOrNull(exchange),
    pending: addressOrNull(pending),
    announcedAt: Number(decodeWord(announcedAt)),
  };
}

export type ExitExchangePhase =
  /** Shares are not locked: they trade anywhere, and the exchange adds nothing. */
  | "unlocked"
  | "off"
  /** Voted in, waiting for the 30 days. */
  | "announced"
  /** The 30 days are over: anyone can switch it on. */
  | "ready"
  | "on"
  /** The named or pending exchange is not the one this app knows. */
  | "other";

export function exitExchangeState(
  read: ExitExchangeRead,
  known: string | null,
  now: number,
): { phase: ExitExchangePhase; opensAt: number | null } {
  if (!read.transfersLocked) return { phase: "unlocked", opensAt: null };
  const ours = (a: string | null) =>
    a !== null && known !== null && same(a, known);
  if (read.exchange !== null) {
    return { phase: ours(read.exchange) ? "on" : "other", opensAt: null };
  }
  if (read.pending === null) return { phase: "off", opensAt: null };
  if (!ours(read.pending)) return { phase: "other", opensAt: null };
  const opensAt = read.announcedAt + UNLOCK_NOTICE;
  return { phase: now >= opensAt ? "ready" : "announced", opensAt };
}
