/**
 * The words of the money screens that are a function of numbers: how a rate, a count of Shares and a small amount of
 * dollars read, where a project stands (open, quiet, wound down) and what that means for a person, why the door is shut,
 * and the two lines every money sheet carries. Pure: no screen logic, so one test holds the sentences.
 */
import { durationWords } from "../tasks/chain/duration";
import {
  dayText,
  dollarsText,
  type ProjectNumbers,
  quietStateAt,
  timeText,
} from "../money/numbers";

/** Under every live number. */
export const NOT_A_RETURN = "This can go up or down. It is not a return.";
/**
 * The banner on every page and sheet (design 2.7), word for word: the shell draws it under each page, a page that draws
 * its own says so, and every money sheet carries it.
 */
export const TAKE_OUT_BANNER =
  "You can take your money out any time. Nothing here promises a profit.";
/** On every money screen of the test network. */
export const PLAY_MONEY_WORDS =
  "This is a test network. The dollars are play money, not real money.";
/**
 * On every money sheet, whatever the network (the launchpad's own rule R4: the app says the contracts are unaudited).
 * It is said before the press, not after, and it does not replace the terms.
 */
export const UNAUDITED_WORDS =
  "The contracts behind these screens are new and have not been audited.";

const SHARE = 1_000_000_000_000_000_000n;
const DOLLAR = 1_000_000n;

/** A count of Shares: whole above 10 or when it is whole, otherwise two decimals (so a part of a Share is never read as none). */
export function sharesWords(raw: bigint): string {
  const whole = raw / SHARE;
  const hundredths = ((raw % SHARE) * 100n) / SHARE;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (whole >= 10n || raw % SHARE === 0n) return grouped;
  return `${grouped}.${hundredths.toString().padStart(2, "0")}`;
}

/**
 * Dollars for one Share and other small amounts: cents above 1 dollar; below it up to six decimals (trailing zeros dropped,
 * never fewer than two decimals), rounded down, so a Share worth 0.010058 does not read as 0.01.
 */
export function smallDollarsText(raw: bigint): string {
  if (raw >= DOLLAR) return dollarsText(raw);
  // Six decimals, trailing zeros dropped, never fewer than two.
  const decimals = raw.toString().padStart(6, "0").replace(/0+$/, "");
  return `0.${decimals.padEnd(2, "0")}`;
}

/**
 * Dollars exactly as a call carries them: every non-zero decimal up to the six a dollar has, never rounded, with two
 * decimals at least once there are any ("25", "25.50", "25.123456"). For an amount a person typed or a call will move.
 */
export function exactDollarsText(raw: bigint): string {
  const whole = (raw / DOLLAR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = (raw % DOLLAR)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return decimals === "" ? whole : `${whole}.${decimals.padEnd(2, "0")}`;
}

/**
 * A daily rate in parts per million of the project's money, as a percent, to the last digit it has (a part per million is
 * 0.0001%): 1000 reads "0.10%", 1049 reads "0.1049%", and a rate above nothing never reads "0.00%".
 */
export function rateWords(ppm: number): string {
  const whole = Math.floor(ppm / 10_000);
  const decimals = String(ppm % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${whole}.${decimals}%`;
}

/** "about 3 days", "about 1 day", "less than a day": a span of seconds for people. */
export function spanWords(seconds: number): string {
  const days = Math.round(seconds / 86_400);
  if (seconds < 43_200) return "less than a day";
  return `about ${days} ${days === 1 ? "day" : "days"}`;
}

/** The share of anything above what backers put in that the Team's side gets, as a whole percent, or null with no Shares. */
export function teamPartPercent(numbers: ProjectNumbers): number | null {
  const total = numbers.shares.backers + numbers.shares.teamCounted;
  if (total === 0n || numbers.shares.teamCounted === 0n) return null;
  return Number((numbers.shares.teamCounted * 100n) / total);
}

/** What the allowance lets the team take in a day, and what it holds now, in one sentence. */
export function allowanceWords(numbers: ProjectNumbers): string {
  const { ratePpm, box } = numbers.allowance;
  if (ratePpm === 0)
    return "The team's daily allowance is switched off, so nothing goes into the allowance box.";
  const perDay = (numbers.money.pot * BigInt(ratePpm)) / 1_000_000n;
  return `The team can take up to ${rateWords(ratePpm)} of the project's money a day (about ${dollarsText(perDay)} dollars today). It holds ${dollarsText(box)} dollars now.`;
}

export interface StateWords {
  /** One word for a label: "Open", "Quiet", "Dormant", "Can be wound down", "Wound down". */
  label: string;
  /** What it means for a person, in a sentence or two. */
  meaning: string;
}

/**
 * Where the project stands at `now` and what that means for a person. The state's word is the record's three fixed
 * times read at `now`; what the chain does is decided by the chain.
 */
export function stateWords(numbers: ProjectNumbers, now: number): StateWords {
  const state = quietStateAt(numbers, now);
  const since = numbers.quiet.quietFrom;
  switch (state) {
    case "active":
      return {
        label: "Open",
        meaning: `The team checked in on ${dayText(numbers.clock.lastCheckIn)}. ${
          numbers.clock.activeUntil
            ? `If it has not checked in again by ${dayText(numbers.clock.activeUntil)}, it goes quiet: new backing and the allowance stop. `
            : ""
        }You can take your money out any time.`,
      };
    case "quiet":
      return {
        label: "Quiet",
        meaning: `The team has not checked in since ${dayText(numbers.clock.lastCheckIn)}${since ? ` (quiet from ${dayText(since)})` : ""}. New backing and the allowance are stopped until it does. You can take your money out any time.`,
      };
    case "dormant":
      return {
        label: "Dormant",
        meaning: `The team has been quiet for months. New backing and the allowance are stopped. If it stays quiet${numbers.quiet.windableFrom ? ` until ${dayText(numbers.quiet.windableFrom)}` : ""}, anyone can wind the project down. You can take your money out any time.`,
      };
    case "may_wind_down":
      return {
        label: "Can be wound down",
        meaning: `The team has been quiet for ${quietWaitWords(numbers)}, so anyone can now wind the project down. New backing and the allowance are stopped. You can take your money out any time.`,
      };
    case "wound_down":
      return {
        label: "Wound down",
        meaning:
          "This project has wound down for good. No one can back it or draw an allowance. What is left is for the people who hold Shares: take yours out.",
      };
  }
}

/** Why the door is shut, in words, or null while it is open. */
export function doorShutWords(
  numbers: ProjectNumbers,
  now: number,
): string | null {
  const state = quietStateAt(numbers, now);
  if (state === "wound_down")
    return "This project has wound down, so nobody can back it any more.";
  if (state !== "active")
    return `The team has not checked in since ${dayText(numbers.clock.lastCheckIn)}, so new backing is paused until it does.`;
  if (!numbers.door.switchOn)
    return "The team has closed the door to new backing for now.";
  if (!numbers.door.openNow)
    return "The door to new backing is shut right now. Look again in a moment.";
  return null;
}

/** A time for a sentence about when something becomes possible. */
export function whenWords(seconds: number): string {
  return timeText(seconds);
}

/**
 * What the allowance box holds now, as well as it can be known: the Treasury keeps the box as of its last settle (a draw settles
 * first, so it can then hold more), and the server's record works it forward to its own time. The larger of the two is what
 * the screens say. When the Treasury's own cap on the box is known (`onChainCap`, read with the box), the figure is never more
 * than that: money set aside for a task lowers the cap before the box's own figure catches up, and a sheet must not offer more
 * than the Money tab says the box holds at most. The chain decides when a draw is sent.
 */
export function boxNow(
  numbers: ProjectNumbers,
  onChain: bigint,
  onChainCap?: bigint,
): bigint {
  const larger =
    onChain > numbers.allowance.box ? onChain : numbers.allowance.box;
  return onChainCap !== undefined && larger > onChainCap ? onChainCap : larger;
}

/** A span of seconds for a sentence: minutes or hours on a test network's short unit, days on a real one. */
export function spanOf(seconds: number): string {
  if (seconds < 3_600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3_600);
    return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(seconds / 86_400);
  return `about ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * How long the team may be quiet before anyone can wind the project down: this project's own wait (its wind-down units of
 * its time unit), "about half a year" on a real network and hours on a test network's short unit.
 */
export function quietWaitWords(numbers: ProjectNumbers): string {
  const secs = numbers.limits.windDownUnits * numbers.unit;
  const days = secs / 86_400;
  return days >= 150 && days <= 220 ? "about half a year" : spanOf(secs);
}

// --- Money set aside for tasks, on the Back and Take out sheets (plan section 5.10) -------------------------------------

/** "1 dollar", "25 dollars", "0.43 dollars": an amount in a sentence. */
function amountWords(raw: bigint): string {
  return raw === 1_000_000n ? "1 dollar" : `${smallDollarsText(raw)} dollars`;
}

/**
 * On the Back sheet, the line about money set aside for tasks: "none" as ever, and with money set aside, what that means for
 * the price (the chain's own `locked` figure is what the quote counts at full value).
 */
export function backLockedWords(locked: bigint): string {
  return locked === 0n
    ? "Money set aside for tasks: none."
    : `Money set aside for tasks: ${amountWords(locked)}. You pay for it at full value now. If the task is paid, that cost is shared by everyone who holds; if it is not, the money comes back to the project.`;
}

/**
 * On the Back sheet, when the record shows a plan nobody can take yet or one that can be taken now: said from the record's
 * rows, never from a read. `from` is when the earliest can be taken, or null when one can be taken now.
 */
export function backPlannedWords(input: {
  /** The most the plan may set aside, or the sum of the most of every plan when there are several. */
  max: bigint;
  count: number;
  from: number | null;
}): string {
  const what =
    input.count === 1 ? "for a task" : `in all for ${input.count} tasks`;
  const when =
    input.from === null
      ? "and it can be taken now"
      : `from ${timeText(input.from)}`;
  return `The team plans to pay up to ${amountWords(input.max)} ${what}, ${when}. You can take your money out any time.`;
}

/** The link on the Take out sheet to where an owed amount is claimed. */
export const WHERE_TO_CLAIM = "Where you claim it";

/**
 * On the Take out sheet, when taking out now leaves money owed for a task: what you get now and what you could be owed later.
 * Both numbers are the chain's own quote; `dueSecs` is the record's limit when the page has it (the sentence stands without).
 */
export function takeOutTaskWords(input: {
  cash: bigint;
  note: bigint;
  dueSecs: number | null;
}): string {
  const aside =
    input.dueSecs === null
      ? "Part of the project's money is set aside for a task."
      : `Part of the project's money is set aside for a task, for up to ${durationWords(input.dueSecs)}.`;
  return `${aside} You get ${amountWords(input.cash)} now, and up to ${amountWords(input.note)} more if the task is not paid in full.`;
}
