/**
 * The rules a DAO made by the launch kits gives its Shares (D76, D77), read in plain terms, and the decisions that open
 * or close trading.
 *
 * - **New Shares** come only from an award for reviewed work, at most a share a year of the Shares that count when
 *   someone leaves (`issuanceAllowance`).
 * - **Trading** is locked from birth: Shares move only to and from the sale's auction. A vote can announce that it
 *   opens, and the Shares let it open only 30 days later (`tradingState`), so a holder who disagrees has that long to
 *   leave.
 *
 * The contracts enforce the 30 days. The rest of the bar for opening trading (audited contracts, a legal read, a track
 * record, a main network) is the app's policy, and the form says so.
 *
 * Pure: `tradingActions.test.mjs` pins the selectors to `cast sig` and the calldata to `cast calldata`.
 */

import {
  type ActionDescription,
  type DecisionDraft,
  DecisionInputError,
  type DescribeContext,
} from "./daoActions.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;

/** How long an announced unlock waits before the Shares let trading open (`Shares.UNLOCK_NOTICE`). */
export const UNLOCK_NOTICE = 30 * DAY;
/** `Shares.NO_CAP`: awards only, with no yearly limit. */
export const NO_CAP = 0xffff;
const YEAR = 365 * DAY;

export const TRADING_SIGNATURES = {
  announce: "announceTransferUnlock()",
  cancel: "cancelTransferUnlock()",
  setLocked: "setTransfersLocked(bool)",
  /** The DAO's own setter, for Shares and Loot together. */
  daoSetLocked: "setTransfersLocked(bool,bool)",
} as const;

/** The Shares' reads behind {@link ShareRules}. */
export const SHARE_RULE_SIGNATURES = {
  awardsOnly: "awardsOnly()",
  issuanceCapBps: "issuanceCapBps()",
  yearStart: "yearStart()",
  yearBase: "yearBase()",
  issuedThisYear: "issuedThisYear()",
  transfersLocked: "transfersLocked()",
  unlockNoticeRequired: "unlockNoticeRequired()",
  unlockAnnouncedAt: "unlockAnnouncedAt()",
  transferExempt: "transferExempt()",
} as const;

/** What a DAO's Shares say about new Shares and trading. */
export interface ShareRules {
  awardsOnly: boolean;
  issuanceCapBps: number;
  /** Unix seconds; zero before the first new Share. */
  yearStart: number;
  yearBase: bigint;
  issuedThisYear: bigint;
  transfersLocked: boolean;
  unlockNoticeRequired: boolean;
  /** Unix seconds; zero when no unlock is announced. */
  unlockAnnouncedAt: number;
  /** The one address Shares may move to or from while locked (the auction), or the zero address. */
  transferExempt: string;
}

function sharesAddress(value: string): string {
  if (!ADDRESS_RE.test(value.trim())) {
    throw new DecisionInputError(
      "sharesToken",
      "The project's Shares are not an address.",
    );
  }
  return value.trim().toLowerCase();
}

/** The vote that announces trading will open: it can open 30 days after this runs, and not before. */
export function announceTradingDecision(input: {
  sharesToken: string;
}): DecisionDraft {
  return {
    to: sharesAddress(input.sharesToken),
    data: selectorOf(TRADING_SIGNATURES.announce),
    lane: "unrestricted",
    title: "Announce that trading opens in 30 days",
    lines: [
      "Once this runs, a second vote can let Shares be sent between wallets, and so be bought and sold, but not until 30 days have passed. The contracts enforce the wait.",
      "Holders who do not want a market have those 30 days to leave with their share of the treasury.",
      "A later vote can withdraw the announcement.",
    ],
  };
}

/** The vote that withdraws a standing announcement: a new one restarts the 30 days. */
export function cancelTradingDecision(input: {
  sharesToken: string;
}): DecisionDraft {
  return {
    to: sharesAddress(input.sharesToken),
    data: selectorOf(TRADING_SIGNATURES.cancel),
    lane: "unrestricted",
    title: "Withdraw the announcement that trading opens",
    lines: [
      "Shares stay locked. Opening trading later needs a new announcement and another 30 days.",
    ],
  };
}

/** The vote that opens trading: refused by the Shares until 30 days after an announcement still standing. */
export function openTradingDecision(input: {
  sharesToken: string;
}): DecisionDraft {
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeFunctionData(TRADING_SIGNATURES.setLocked, ["bool"], [false]),
    lane: "unrestricted",
    title: "Open trading",
    lines: [
      "Shares can then be sent between wallets, so they can be bought and sold anywhere.",
      "It only runs 30 days or more after trading was announced; the Shares refuse it before that.",
    ],
  };
}

/** The vote that locks trading again: at once, and the next opening needs a new 30-day notice. */
export function lockTradingDecision(input: {
  sharesToken: string;
}): DecisionDraft {
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeFunctionData(TRADING_SIGNATURES.setLocked, ["bool"], [true]),
    lane: "unrestricted",
    title: "Lock trading again",
    lines: [
      "Shares can no longer be sent between wallets, except to and from the sale's auction.",
      "Opening trading again needs a new announcement and 30 more days.",
    ],
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (data: string, index: number) =>
  data.slice(10 + index * 64, 10 + (index + 1) * 64);

/** A trading decision in words, or null when the action is not one aimed at this project's Shares (or DAO). */
export function describeTrading(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  const data = action.data.toLowerCase();
  const sel = data.slice(0, 10);
  const of = (draft: DecisionDraft): ActionDescription => ({
    kind: "trading",
    title: draft.title,
    lines: draft.lines,
  });
  const toShares = ctx.projectToken ? same(action.to, ctx.projectToken) : false;
  const placeholder = { sharesToken: action.to };
  if (
    toShares &&
    sel === selectorOf(TRADING_SIGNATURES.announce) &&
    data.length === 10
  )
    return of(announceTradingDecision(placeholder));
  if (
    toShares &&
    sel === selectorOf(TRADING_SIGNATURES.cancel) &&
    data.length === 10
  )
    return of(cancelTradingDecision(placeholder));
  if (
    toShares &&
    sel === selectorOf(TRADING_SIGNATURES.setLocked) &&
    data.length === 74
  ) {
    const value = BigInt(`0x${word(data, 0)}`);
    if (value === 0n) return of(openTradingDecision(placeholder));
    if (value === 1n) return of(lockTradingDecision(placeholder));
    return null;
  }
  if (
    ctx.dao &&
    same(action.to, ctx.dao) &&
    sel === selectorOf(TRADING_SIGNATURES.daoSetLocked) &&
    data.length === 138
  ) {
    const shares = BigInt(`0x${word(data, 0)}`);
    if (shares === 0n) return of(openTradingDecision(placeholder));
    if (shares === 1n) return of(lockTradingDecision(placeholder));
  }
  return null;
}

/** Where trading stands: locked, announced and waiting, ready to open, or open; unknown when the rules could not be read. */
export function tradingState(
  rules: ShareRules | null,
  now: number,
): {
  phase: "unknown" | "open" | "locked" | "announced" | "ready";
  /** When an announced unlock can run (unix seconds). */
  opensAt: number | null;
} {
  if (!rules) return { phase: "unknown", opensAt: null };
  if (!rules.transfersLocked) return { phase: "open", opensAt: null };
  if (!rules.unlockNoticeRequired) return { phase: "ready", opensAt: null };
  if (rules.unlockAnnouncedAt === 0) return { phase: "locked", opensAt: null };
  const opensAt = rules.unlockAnnouncedAt + UNLOCK_NOTICE;
  return { phase: now >= opensAt ? "ready" : "announced", opensAt };
}

/**
 * How many new Shares an award can still create this year (D76). `exitBase` is the Shares that count when someone
 * leaves right now (outside the DAO, less what a lock still holds): a new year starts with it as its base.
 */
export function issuanceAllowance(
  rules: ShareRules | null,
  now: number,
  exitBase: bigint,
):
  | null
  | { kind: "none" }
  | { kind: "awards-only" }
  | { kind: "capped"; left: bigint; of: bigint; resetsAt: number | null } {
  if (!rules) return null;
  if (!rules.awardsOnly) return { kind: "none" };
  if (rules.issuanceCapBps === NO_CAP) return { kind: "awards-only" };
  const cap = BigInt(rules.issuanceCapBps);
  const fresh = rules.yearStart === 0 || now >= rules.yearStart + YEAR;
  const base = fresh ? exitBase : rules.yearBase;
  const of = (base * cap) / 10_000n;
  const issued = fresh ? 0n : rules.issuedThisYear;
  return {
    kind: "capped",
    left: of > issued ? of - issued : 0n,
    of,
    resetsAt: fresh ? null : rules.yearStart + YEAR,
  };
}
