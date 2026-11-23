/**
 * The sentences of the top of a project's page (plan section 7.1), made from the signed record and nothing else: who backs
 * it, how long money has stayed, the last check-in and its weeks in a row, what taking out now would give, and the words of
 * the "Established" hint. Pure, so one test holds every sentence. A part the record could not say gives null and the page
 * draws nothing for it: never "none" and never zero for what is not known.
 */
import { durationWords } from "../tasks/chain/duration";
import type { ProjectNumbers } from "../money/numbers";
import { timeText } from "../money/numbers";
import { FEED_ROUND_TO } from "../money/numbers-social";
import { feedDollars } from "../feed/feed-words";
import { doorShutWords, smallDollarsText } from "../pot/pot-words";
import { unitCount } from "./unit-words";

/** What the money line says about what a take-out would give: the figure of the same name on the Take out sheet. */
export function takeOutNowLine(numbers: ProjectNumbers): string {
  return `Taking out now would give ${smallDollarsText(numbers.value.leaveValue)} dollars for each Share.`;
}

/**
 * How many accounts back it. An account is what is counted (one person can hold several, and on a test network they are
 * free), so no sentence here says "people".
 */
export function peopleLine(holderCount: number): string {
  if (holderCount === 0) return "Nobody backs it yet.";
  if (holderCount === 1) return "1 account backs it.";
  return `${holderCount.toLocaleString("en-GB")} accounts back it.`;
}

/** A length of time for a sentence: days on a real network, minutes or hours on a test one. */
export function windowWords(secs: number): string {
  return durationWords(secs);
}

/** "1 person" / "12 people". */
export function peopleCount(n: number): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? "account" : "accounts"}`;
}

/**
 * Money that stayed, said to the nearest 100 dollars (as the feed says its amounts) so that the money of one account that kept
 * it is never said to the cent: "about 4,800 dollars", or "under 100 dollars" for less than half of that.
 */
export function keptMoney(raw: bigint): string {
  const rounded = ((raw + FEED_ROUND_TO / 2n) / FEED_ROUND_TO) * FEED_ROUND_TO;
  return rounded === 0n
    ? `under ${feedDollars(FEED_ROUND_TO)}`
    : `about ${feedDollars(rounded)}`;
}

/**
 * How long money has stayed (`held.rank`): the money that has been in for the whole window, by how many accounts; or that
 * nobody has kept money in it that long; or that the project is too young to say. Null when the record does not say.
 */
export function keptLine(numbers: ProjectNumbers): string | null {
  const held = numbers.held;
  if (!held?.rank) return null;
  const window = windowWords(held.windows.rankSecs);
  if (held.rank.accounts > 0 && held.rank.money > 0n)
    return `Kept ${window} or more: ${keptMoney(held.rank.money)} by ${peopleCount(held.rank.accounts)}.`;
  // Younger than the window: nothing could have stayed that long yet.
  if (numbers.asOf.time - numbers.launchedAt < held.windows.rankSecs)
    return "Too new to say how long money stays.";
  return `Nobody has kept money in it for ${window} yet.`;
}

/** The run of weekly check-ins in a row (the team's mark on the chain, not a written update), from one unit: weeks on a real network, the unit's own length on a test one. */
export function streakLine(runs: number, unit: number): string | null {
  if (runs < 1) return null;
  return `Check-ins: ${unitCount(runs, unit)} in a row`;
}

/**
 * The last check-in and, when there are weeks in a row, the run. A check-in is the team's weekly mark on the network (the birth of
 * the project when there has been none, which reads as no check-in). It is not the written update the Updates tab and demo day
 * show: those are posts, and a team can write one without checking in and the other way round, so the two have two names.
 */
export function checkInLine(
  numbers: ProjectNumbers,
  when: (unix: number) => string,
): string {
  const last = numbers.streaks?.updates
    ? numbers.streaks.updates.lastAt
    : numbers.clock.lastCheckIn > numbers.launchedAt
      ? numbers.clock.lastCheckIn
      : null;
  const said =
    last === null ? "No check-in yet." : `Last check-in ${when(last)}.`;
  const run = numbers.streaks
    ? streakLine(numbers.streaks.updates.weeks, numbers.unit)
    : null;
  return run ? `${said} ${run}.` : said;
}

/**
 * The door, as a chip: the same answer as the Back box gives for the same moment (the record may have been built before the
 * team's quiet time began), so the chip never says "open" over a box that says backing is paused.
 */
export function doorChip(numbers: ProjectNumbers, now: number): string {
  return doorShutWords(numbers, now) === null
    ? "Open to back"
    : "Closed to new backers";
}

export const ESTABLISHED = "Established";
export const ESTABLISHED_SHEET_TITLE = "What “Established” means";
export const ESTABLISHED_HINT =
  "Established is a hint. It is not a promise, and it changes nothing about your money.";
/** The "Established" line in Details for a record from a server that does not say. */
export const ESTABLISHED_UNTOLD =
  "This server has not said yet whether this project counts as Established. It changes nothing about your money.";
export const ESTABLISHED_UNKNOWN =
  "This could not be worked out just now. It changes nothing about your money.";

/** One line of the Established sheet: a tick or a dash, said in words as well as drawn. */
export interface EstablishedRow {
  met: boolean | null;
  text: string;
}

/** A tenth of a percent is the smallest step of a share in ten-thousandths read as a whole percent, rounded down. */
function percent(bps: number): number {
  return Math.floor(bps / 100);
}

/**
 * The three lines the sheet shows, from the record's own rule and inputs (nothing is typed here): how much of the money
 * has stayed, how many people back it, and how many run it. A met line says so and one that is not says what is missing.
 */
export function establishedRows(
  numbers: ProjectNumbers,
): EstablishedRow[] | null {
  const e = numbers.established;
  if (!e) return null;
  const window = windowWords(e.rule.heldSecs);
  const need = percent(e.rule.minHeldBps);
  const stayed =
    e.heldBps === null
      ? {
          met: null,
          text: `Most of the money has stayed: not known yet. It needs ${need}% here ${window} or more.`,
        }
      : e.heldBps >= e.rule.minHeldBps
        ? {
            met: true,
            text: `Most of the money has stayed: ${percent(e.heldBps)}% of it has been here ${window} or more. It needs ${need}%.`,
          }
        : {
            met: false,
            text: `Not yet: ${percent(e.heldBps)}% of the money has been here ${window} or more. It needs ${need}%.`,
          };
  const people =
    e.accounts === null
      ? {
          met: null,
          text: `At least ${e.rule.minAccounts} accounts back it: not known yet.`,
        }
      : e.accounts >= e.rule.minAccounts
        ? {
            met: true,
            text: `At least ${e.rule.minAccounts} accounts back it: ${e.accounts} do now.`,
          }
        : {
            met: false,
            text: `Not yet: at least ${e.rule.minAccounts} accounts need to back it, and ${e.accounts} do now.`,
          };
  // A Council is "Several accounts", never "two people": the record's own runner kind when the milestone 9 keys were read,
  // and otherwise the two answers a record signed before that key carries (only a Council is run by more than one account
  // without being a Pair). A Pair's and a single founder's words do not change.
  const kind = numbers.runner.kind;
  const council =
    kind === "council" ||
    ((kind === undefined || kind === null) &&
      e.twoSigners &&
      !numbers.runner.isPair);
  const run = council
    ? e.twoSigners
      ? { met: true, text: "Several accounts run it." }
      : { met: false, text: "Not yet: several accounts need to run it." }
    : e.twoSigners
      ? { met: true, text: "Two accounts run it." }
      : { met: false, text: "One account runs it. Not yet: it needs two." };
  return [stayed, people, run];
}

/** "Numbers as of 18 Nov, 14:05". */
export function asOfLine(numbers: ProjectNumbers): string {
  return `Numbers as of ${timeText(numbers.asOf.time)}`;
}
