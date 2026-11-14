/**
 * What the Backing block says, in plain words (docs/v3-review/PLAIN-WORDS.md): the state of backing, the facts, what a
 * backer can and cannot do, and every refusal the contract can make said as a sentence with a next step.
 *
 * Why it reads the way it does: the record comes first and money second, so this copy says what backing is and is not
 * before it offers an action, never shows a price on a project's page (price lives in Home's feed), and never hints at
 * returns. The legal lines (what a backer may lose, that units are not Shares, that nothing checks a milestone is true
 * except backers leaving, that the code has not had an outside review) are kept whole and always visible next to the
 * action they guard.
 *
 * Pure and alias-free: `backing-copy.test.mjs` drives it under `node --test`.
 */

import {
  type BackingErrorName,
  backingErrorIn,
  formatAmount,
  type MilestoneView,
  type NextMilestone,
  type PoolPhase,
  type PoolSnapshot,
  type QuoteFacts,
} from "@creaton/core/launchpad/backing.ts";
import { isUserRejection } from "@creaton/core/launchpad/wallet-errors.ts";

// ---- money and dates ---------------------------------------------------------------------------

/** An amount of the backing token with its symbol: "12.5 tTEST". Without a symbol, the number alone is not a promise of a unit. */
export function money(amount: bigint, quote: QuoteFacts): string {
  const number = formatAmount(amount, quote.decimals);
  return quote.symbol ? `${number} ${quote.symbol}` : number;
}

/** Units, always as a whole-number-friendly amount of "units". */
export function unitsPhrase(units: bigint): string {
  const text = formatAmount(units, 18);
  return text === "1" ? "1 unit" : `${text} units`;
}

/** A date with its time and zone, for a deadline someone must act before ("Nov 5, 2026, 2:00 PM PST"). */
export function whenWords(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** A past date without the time: "Nov 5, 2026". */
export function dayWords(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** How long, in whole days or hours, from `now` to `at`: "6 days", "1 day", "5 hours", "less than an hour". */
export function spanWords(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86_400) {
    const days = Math.floor(s / 86_400);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (s >= 3_600) {
    const hours = Math.floor(s / 3_600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return "less than an hour";
}

// ---- where backing stands -----------------------------------------------------------------------

export const BACKING_HEADING = "Backing";

/** The one line that says what a backer can and cannot do, shown with every state that takes money. */
export const HONEST_LINE =
  "You can sell any time. At each milestone you can stay or leave with your held money back.";

/** What backing is, in one line, for a project that has not opened it and for someone who has never seen it. */
export const WHAT_IT_IS =
  "Backers put money behind the project and receive backing units. A part of what they pay is held, and the founder gets it a part at a time when a milestone is posted with a public record behind it.";

/** What the free test token is, beside "Get test tokens" in the Backing block. */
export const TEST_TOKEN_BACKING_NOTE =
  "This token is free and worth nothing: anyone can get more of it. It is here only to try backing a project.";

export const NOT_SHARES_LINE =
  "Backing units are not Shares: they carry no vote in the project and cannot be sent to another account.";

/** What each state says. `founder` is who may open it. */
export function stateLine(phase: PoolPhase, founder: boolean): string {
  switch (phase) {
    case "none":
      return founder
        ? "Backing is not open for this project. You can open it so people can put money behind it, with a part held until you post a milestone."
        : "Backing is not open for this project.";
    case "waiting":
      return "The opening round is open. People bid, the round works out one price for everyone, and nobody wins by being first.";
    case "live":
      return "Backing is open. People can put money behind this project and sell their units at any time.";
    case "failed":
      return "The opening round did not reach its minimum. Everyone who bid takes their money back, and nothing was opened. The founder can open backing again.";
    case "abandoned":
      return "This project stopped releasing money, so backing has closed for good. Backers sell their units and get their held money back. Nobody can put in more.";
  }
}

/** The short label in the block's corner. */
export const PHASE_CHIP: Record<PoolPhase, string> = {
  none: "Not open",
  waiting: "Opening round",
  live: "Open",
  failed: "Round not reached",
  abandoned: "Closed for good",
};

/** The next milestone as a fact on the block. */
export function nextMilestoneFact(next: NextMilestone): {
  label: string;
  value: string;
} {
  switch (next.kind) {
    case "window":
      return {
        label: "Leave by",
        value: whenWords(next.leaveBy),
      };
    case "release":
      return {
        label: "Next milestone",
        value: "Waiting for someone to settle it",
      };
    case "cancel":
      return {
        label: "Next milestone",
        value: "Not settled in time: it can only be closed",
      };
    case "wait":
      return {
        label: "Next milestone can be posted from",
        value: whenWords(next.from),
      };
    case "ready":
      return { label: "Next milestone", value: "Can be posted now" };
  }
}

/** The line under the facts that says what the open milestone means for a backer. */
export function milestoneLine(
  next: NextMilestone,
  held: string,
): string | null {
  switch (next.kind) {
    case "window":
      return `A milestone was posted. Until ${whenWords(next.leaveBy)} you can stay, and a part of your held money goes to the project, or leave and take all of your held money back${held ? ` (now ${held})` : ""}.`;
    case "release":
      return "The time to leave is over. Anyone can settle the milestone now, which sends the part that was not taken back to the project.";
    case "cancel":
      return "Nobody settled this milestone in time, so nothing is released. It can be closed, and the founder can post another.";
    default:
      return null;
  }
}

// ---- a backer's own position ----------------------------------------------------------------------

export function positionLine(
  snapshot: PoolSnapshot,
  quote: QuoteFacts,
): string | null {
  if (snapshot.holderUnits === 0n) return null;
  const parts = [
    `You hold ${unitsPhrase(snapshot.holderUnits)}.`,
    `Selling them now pays ${money(snapshot.holderSellValue, quote)}.`,
  ];
  if (snapshot.holderEscrow > 0n)
    parts.push(
      `${money(snapshot.holderEscrow, quote)} of what you paid is held for the project.`,
    );
  return parts.join(" ");
}

// ---- before you put money in (always visible, never collapsed) ------------------------------------

/** What a person has to read before backing. Each line is whole, and none is shortened to fit. */
export function backingLimits(): string[] {
  return [
    "You may get back less than you paid.",
    "Selling before a milestone gives up the part of your money that is held for the project to the backers who stay. To take it back, leave at a milestone.",
    "A milestone is the founder's word that a step was reached, with a public record behind it. Nothing checks that it is true except backers choosing to leave.",
    "Money released at a milestone goes to the project's shared money, which Share holders control.",
    NOT_SHARES_LINE,
    "The backing code has not had an outside security or legal review yet.",
    "Do not put in money you cannot lose.",
  ];
}

// ---- reads that did not complete ---------------------------------------------------------------------

export const READING_LINE = "Reading how backing stands…";

export function unreadableLine(): string {
  return "Couldn't read how backing stands. Nothing here is a statement that the project has none.";
}

export function staleReadLine(updatedAt: number, now = Date.now()): string {
  if (updatedAt <= 0)
    return "The last read failed, so this may be out of date.";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return `The last read failed, so this may be out of date: it shows how backing stood ${spanWords(seconds)} ago.`;
}

export function cutLine(cut: boolean, unreadable: number): string | null {
  if (!cut && unreadable === 0) return null;
  const parts: string[] = [];
  if (cut)
    parts.push(
      "This project has more backing history than could be read here, so the oldest is left out and the totals are at least what is shown.",
    );
  if (unreadable > 0)
    parts.push(
      `${unreadable} ${unreadable === 1 ? "record" : "records"} could not be read and ${unreadable === 1 ? "is" : "are"} left out.`,
    );
  return parts.join(" ");
}

export const NOT_CONFIRMED_LINE =
  "We could not confirm that this project was made here, so backing is not shown for it. Check the project before you put money anywhere.";

export const WRONG_TOKEN_LINE =
  "This site and the project do not agree on the token backers pay in, so nothing can be sent from here. Tell whoever runs this site.";

export function notHereLine(
  why: "no-dao" | "no-network" | "no-factory",
): string {
  switch (why) {
    case "no-dao":
      return "This project has no shared money yet, so it cannot be backed.";
    case "no-network":
      return "This project does not say which network it lives on, so backing is not shown for it.";
    case "no-factory":
      return "Backing is not set up on this project's network on this site.";
  }
}

// ---- founder -------------------------------------------------------------------------------------

export const OPEN_NOW_LABEL = "Open backing now";
export const OPEN_ROUND_LABEL = "Open with a fair round";
export const OPEN_NOW_HELP =
  "Backing opens at once at a starting price, with a limit on how much one account can put in for a short time after it opens.";
export const OPEN_ROUND_HELP =
  "People bid until the round ends, the round works out one price for everyone, and backing opens at that price. If the round raises less than your minimum, everyone gets their money back and nothing opens.";
export const FOUNDER_ACCOUNT_LINE =
  "Only the account that made the project, or the project itself, can do this. Switch to that account to go on.";

export const NO_FOUNDER_LINE =
  "This project was made without a founder on record, so backing can only be opened by a vote of the project.";

export const POST_MILESTONE_HELP =
  "A milestone points at one public record of yours: an update, a goal you reached, or work your team accepted. Backers then have a fixed time to stay or leave with their held money. The date it ends is shown once you post.";

export const NO_RECORDS_LINE =
  "There is no record to point at yet. Post an update, mark a goal as reached, or accept a piece of work, then come back.";

// ---- the contract's own refusals ------------------------------------------------------------------

/** A failed step as people read it: what happened and what to do next, and the raw words for Technical details. */
export interface BackingFailure {
  text: string;
  detail: string | null;
}

const REFUSALS: Record<BackingErrorName, string> = {
  Expired: "This took too long to go through, so nothing was done. Try again.",
  ZeroAmount:
    "That amount is too small to buy or sell anything. Try a larger one.",
  InsufficientUnits: "You do not hold that many units. Sell fewer.",
  Slippage:
    "The price moved more than you allowed, so nothing was bought or sold. Try again, or allow a bigger move.",
  IsAbandoned:
    "Backing for this project has closed for good, so nothing can be put in. You can still sell.",
  EarlyCapReached:
    "While a project is new, one account can put in only a limited amount. Try a smaller amount.",
  TooLarge: "That amount is too large. Try a smaller one.",
  BadQuoteTransfer:
    "The token did not move the exact amount asked, so nothing was done. Tell whoever runs this site.",
  NotClaimant:
    "Only the account that made the project, or the project itself, can post a milestone.",
  MilestoneOpen:
    "A milestone is already open. It has to be settled before another is posted.",
  NoOpenMilestone: "No milestone is waiting to be settled.",
  TooSoon:
    "A new milestone cannot be posted yet. The date it can is shown on this page.",
  WindowOver: "The time to leave at this milestone is over.",
  WindowNotOver:
    "Backers can still leave at this milestone, so it cannot be settled yet.",
  NoSay:
    "You cannot do that here: you hold nothing, you bought after this milestone was posted, or you have no part in it.",
  AlreadyDone: "That was already done.",
  NotAbandonable: "This project is not at the point where it can be closed.",
  NothingOwed: "Nothing is waiting to be paid.",
  RoundNotLive:
    "The opening round has not finished, so this cannot be done yet.",
  RoundNotWaiting: "This opening round is already settled.",
  RoundNotOver: "The opening round has not ended yet. Try again once it has.",
  BadAuction:
    "The opening round could not be set up as asked, so nothing was done. Tell whoever runs this site.",
  UnprovenDao:
    "This project was not made in a way backing can use, so nothing was opened.",
  AlreadyOpen: "This project already has backing open.",
  NotAllowed:
    "Only the account that made the project, or the project itself, can open backing.",
  RoundsOff: "Opening rounds are not offered on this network.",
  MinimumTooLow: "That minimum is lower than the least a round may ask for.",
  ERC20InsufficientBalance:
    "Your account does not hold enough of the backing token for that.",
  ERC20InsufficientAllowance:
    "The backing was not allowed to take that amount. Try again.",
};

const REFUSED_TEXT =
  "That step was refused, so nothing changed. Refresh and try again.";

/**
 * Words the network and a browser wallet use that are not words for people: a revert, a status, a URL, a hex blob.
 * A sentence containing any of them is never shown in main copy.
 */
const RAW_WORDS =
  /revert|\bRPC\b|\bHTTP\b|\bURL\b|\bstatus\b|0x[0-9a-fA-F]{4,}|Details:|Version:|Failed to fetch|NetworkError|Load failed|\bgas\b/i;

/**
 * A failed step in plain words, whichever way the network spells the refusal. A refusal the contract names (by name or
 * by the selector a node shows in its place) becomes a sentence with a next step; a sentence the app already wrote for
 * people is kept; a person saying no in their wallet is said as that; anything else is the general line, with the raw
 * words kept for "Technical details".
 */
export function backingFailure(message: string): BackingFailure {
  const raw = (message ?? "").trim();
  const detail = raw === "" ? null : raw;
  if (isUserRejection(raw))
    return {
      text: "You said no in your wallet, so nothing was sent.",
      detail: null,
    };
  const named = backingErrorIn(raw);
  if (named) return { text: REFUSALS[named], detail };
  if (
    /^[A-Z][^\n]*[.!?]$/.test(raw) &&
    !RAW_WORDS.test(raw) &&
    !/^[A-Za-z-]+:\s/.test(raw)
  ) {
    return { text: raw, detail: null };
  }
  return { text: REFUSED_TEXT, detail };
}

/** Every refusal sentence, for the test that checks none of them speaks in protocol words. */
export const ALL_REFUSAL_LINES: readonly string[] = [
  ...Object.values(REFUSALS),
  REFUSED_TEXT,
];

// ---- a milestone's record ---------------------------------------------------------------------

/** What happened to a milestone, in a short line for its row. */
export function milestoneOutcomeLine(
  outcome: "open" | "released" | "cancelled",
  amount: string,
  leavers: number,
): string {
  const left =
    leavers === 0
      ? ""
      : leavers === 1
        ? " 1 backer left."
        : ` ${leavers} backers left.`;
  switch (outcome) {
    case "released":
      return `Released ${amount} to the project.${left}`;
    case "cancelled":
      return `Not settled in time: nothing was released.${left}`;
    case "open":
      return `Open.${left}`;
  }
}

/** Where a milestone's pointed-at record shows: the first 8 characters are enough to tell two apart. */
export function shortRef(ref: string): string {
  return ref.replace(/^0x/, "").slice(0, 8);
}

export type { MilestoneView };
