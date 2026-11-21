/**
 * Each money step as one plan: read what the chain says now, then build the calls with a guard made from that quote.
 * Back sets `minShares` from `quoteBack`; Take out sets `minCash` from `quoteTakeOut`; the Team take-out has only an
 * estimate to go on (there is no exact quote view for Team Shares), so its guard is lower still. A plan whose quote says
 * there is nothing to get is refused here, so no press can spend a signature on a call the contract will refuse.
 */
import {
  backCalls,
  leaveCall,
  leaveTeamCall,
  type PotCall,
  takeOutWithParkedCalls,
  ZERO_ADDRESS,
} from "./pot-calls.ts";
import {
  type BackQuote,
  dollarHasPayAndCall,
  quoteBack,
  quoteTakeOut,
  type ReadCall,
  type TakeOutQuote,
  teamValue,
} from "./pot-reads.ts";

/** How much less than a quote the chain may give when the press lands: 0.5%, in ten-thousandths. */
export const QUOTE_TOLERANCE_BPS = 50n;

/** Team Shares have no exact quote, so the guard on their take-out is wider: 2%, in ten-thousandths. */
const TEAM_TOLERANCE_BPS = 200n;

const BPS = 10_000n;

/** `value` less `bps` ten-thousandths, rounded down. */
export function withTolerance(value: bigint, bps: bigint): bigint {
  return (value * (BPS - bps)) / BPS;
}

/** A Back ready to send: the quote the sheet shows and the calls that carry its guard. */
export interface BackPlan {
  quote: BackQuote;
  /** The fewest Shares the press accepts. */
  minShares: bigint;
  calls: PotCall[];
  /** True when the whole Back is one signature (the dollar has `transferAndCall`). */
  oneSignature: boolean;
}

/**
 * Plan backing `amount`: ask the chain for the quote, then build the calls with `minShares` set from it. Refused (`null`)
 * when the amount would buy no Shares.
 */
export async function planBack(
  read: ReadCall,
  input: {
    dollar: string;
    treasury: string;
    amount: bigint;
    /**
     * Who gets the Shares. Default: the payer, which the one-call form reads from the zero address; the two-call form
     * has no such shortcut, so there `to` must be given (the account that sends).
     */
    to?: string;
    /** Skip the read of whether the dollar has `transferAndCall` when the caller already knows. */
    payAndCall?: boolean;
  },
): Promise<BackPlan | null> {
  const quote = await quoteBack(read, input.treasury, input.amount);
  if (quote.shares === 0n) return null;
  const payAndCall =
    input.payAndCall ?? (await dollarHasPayAndCall(read, input.dollar));
  const minShares = withTolerance(quote.shares, QUOTE_TOLERANCE_BPS);
  return {
    quote,
    minShares,
    oneSignature: payAndCall,
    calls: backCalls({
      dollar: input.dollar,
      treasury: input.treasury,
      amount: input.amount,
      minShares,
      to: input.to ?? ZERO_ADDRESS,
      payAndCall,
    }),
  };
}

/** A take-out ready to send. */
export interface TakeOutPlan {
  quote: TakeOutQuote;
  /** The least cash the press accepts; below it the whole call is refused and nothing changes. */
  minCash: bigint;
  call: PotCall;
}

/**
 * Plan taking `shares` of `holder` out, paid to `to`: ask the chain for the quote, then build the one call with `minCash`
 * set from it. Refused (`null`) when the quote is zero (nothing to pay, or more Shares than the holder has).
 */
export async function planTakeOut(
  read: ReadCall,
  input: { treasury: string; holder: string; shares: bigint; to: string },
): Promise<TakeOutPlan | null> {
  const quote = await quoteTakeOut(
    read,
    input.treasury,
    input.holder,
    input.shares,
  );
  if (quote.cashNow === 0n) return null;
  const minCash = withTolerance(quote.cashNow, QUOTE_TOLERANCE_BPS);
  return {
    quote,
    minCash: minCash === 0n ? 1n : minCash,
    call: leaveCall({
      treasury: input.treasury,
      shares: input.shares,
      minCash: minCash === 0n ? 1n : minCash,
      to: input.to,
    }),
  };
}

/** What `shares` Team Shares would pay, from the value of one whole Share (a rough figure: it is a 6-decimal number). */
export function teamCashEstimate(
  valuePerShare: bigint,
  shares: bigint,
): bigint {
  return (valuePerShare * shares) / 1_000_000_000_000_000_000n;
}

/** A Team take-out ready to send, with only an estimate behind it. */
export interface TeamTakeOutPlan {
  /** What the chain's `teamValue` gives for these Shares now: an estimate, shown as "about". */
  estimate: bigint;
  minCash: bigint;
  call: PotCall;
}

/** Plan taking `shares` Team Shares out. Refused (`null`) when the estimate is zero: they pay only above what backers put in. */
export async function planTeamTakeOut(
  read: ReadCall,
  input: { treasury: string; shares: bigint; to: string },
): Promise<TeamTakeOutPlan | null> {
  const estimate = teamCashEstimate(
    await teamValue(read, input.treasury),
    input.shares,
  );
  if (estimate === 0n) return null;
  const guard = withTolerance(estimate, TEAM_TOLERANCE_BPS);
  const minCash = guard === 0n ? 1n : guard;
  return {
    estimate,
    minCash,
    call: leaveTeamCall({
      treasury: input.treasury,
      shares: input.shares,
      minCash,
      to: input.to,
    }),
  };
}

/**
 * What taking `walletShares` (in the wallet) and `parkedShares` (in the pause contract) out together would give now: the sum of
 * two chain quotes. `Treasury.quoteTakeOut` only needs that its holder holds the Shares, so the wallet part is quoted for the
 * holder and the parked part for the pause contract, which holds them. Nothing parked asks one quote; nothing in the wallet
 * asks the other.
 */
export async function quoteParkedTakeOut(
  read: ReadCall,
  input: {
    treasury: string;
    pause: string | null;
    holder: string;
    walletShares: bigint;
    parkedShares: bigint;
  },
): Promise<TakeOutQuote> {
  if (input.parkedShares > 0n && !input.pause)
    throw new Error("Parked Shares need the project's pause contract");
  const none: TakeOutQuote = { cashNow: 0n, note: 0n, arrivingLeftBehind: 0n };
  const wallet =
    input.walletShares > 0n
      ? await quoteTakeOut(
          read,
          input.treasury,
          input.holder,
          input.walletShares,
        )
      : none;
  const parked =
    input.parkedShares > 0n && input.pause
      ? await quoteTakeOut(
          read,
          input.treasury,
          input.pause,
          input.parkedShares,
        )
      : none;
  return {
    cashNow: wallet.cashNow + parked.cashNow,
    note: wallet.note + parked.note,
    arrivingLeftBehind: wallet.arrivingLeftBehind + parked.arrivingLeftBehind,
  };
}

/** A take-out of Shares that may be partly parked, ready to send as one batch. */
export interface ParkedTakeOutPlan {
  /** The two quotes added: the wallet's part and the parked part. */
  quote: TakeOutQuote;
  /** The least cash the whole press accepts. */
  minCash: bigint;
  /** `[unpark, leave]` when something is parked; just `[leave]` when nothing is. */
  calls: PotCall[];
}

/**
 * Plan taking `walletShares` (in the wallet) and `parkedShares` (in the pause contract) out in one press: the quote is the
 * sum of two chain quotes (`Treasury.quoteTakeOut` reads only that its holder holds the Shares, so the wallet part is quoted
 * for the holder and the parked part for the pause contract, which holds them), the guard is the usual tolerance under that
 * sum, and the calls are `unpark` then `leave` of everything. Refused (`null`) when the sum is zero.
 */
export async function planTakeOutParked(
  read: ReadCall,
  input: {
    treasury: string;
    pause: string | null;
    holder: string;
    walletShares: bigint;
    parkedShares: bigint;
    to: string;
  },
): Promise<ParkedTakeOutPlan | null> {
  const quote = await quoteParkedTakeOut(read, input);
  if (quote.cashNow === 0n) return null;
  const guard = withTolerance(quote.cashNow, QUOTE_TOLERANCE_BPS);
  const minCash = guard === 0n ? 1n : guard;
  return {
    quote,
    minCash,
    calls: takeOutWithParkedCalls({
      treasury: input.treasury,
      pause: input.pause,
      walletShares: input.walletShares,
      parkedShares: input.parkedShares,
      minCash,
      to: input.to,
    }),
  };
}
