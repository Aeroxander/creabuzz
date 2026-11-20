/**
 * The sentences of the top of a project's page (plan section 7.1), made from the signed record and nothing else: who backs
 * it, how long money has stayed, the last update and its weeks in a row, what taking out now would give, and the words of
 * the "Established" hint. Pure, so one test holds every sentence. A part the record could not say gives null and the page
 * draws nothing for it: never "none" and never zero for what is not known.
 */
import { durationWords } from "../tasks/chain/duration";
import type { ProjectNumbers } from "../money/numbers";
import { timeText } from "../money/numbers";
import { smallDollarsText } from "../pot/pot-words";

/** What the money line says about what a take-out would give: the figure of the same name on the Take out sheet. */
export function takeOutNowLine(numbers: ProjectNumbers): string {
  return `Taking out now would give ${smallDollarsText(numbers.value.leaveValue)} for each Share.`;
}

/** How many people back it. */
export function peopleLine(holderCount: number): string {
  if (holderCount === 0) return "Nobody backs it yet.";
  if (holderCount === 1) return "1 person backs it.";
  return `${holderCount.toLocaleString("en-GB")} people back it.`;
}

/** A length of time for a sentence: days on a real network, minutes or hours on a test one. */
export function windowWords(secs: number): string {
  return durationWords(secs);
}

/** "1 person" / "12 people". */
export function peopleCount(n: number): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? "person" : "people"}`;
}

/**
 * How long money has stayed (`held.rank`): the money that has been in for the whole window, by how many people; or that
 * nobody has kept money in it that long; or that the project is too young to say. Null when the record does not say.
 */
export function keptLine(numbers: ProjectNumbers): string | null {
  const held = numbers.held;
  if (!held?.rank) return null;
  const window = windowWords(held.windows.rankSecs);
  if (held.rank.accounts > 0 && held.rank.money > 0n)
    return `Kept ${window} or more: ${smallDollarsText(held.rank.money)} by ${peopleCount(held.rank.accounts)}.`;
  // Younger than the window: nothing could have stayed that long yet.
  if (numbers.asOf.time - numbers.launchedAt < held.windows.rankSecs)
    return "Too new to say how long money stays.";
  return `Nobody has kept money in it for ${window} yet.`;
}

/** The weeks of updates in a row, from one week. */
export function streakLine(weeks: number): string | null {
  if (weeks < 1) return null;
  return `Updates: ${weeks.toLocaleString("en-GB")} ${weeks === 1 ? "week" : "weeks"} in a row`;
}

/**
 * The last update and, when there are weeks in a row, the run. The last update is the team's last check-in (the birth of
 * the project when there has been none, which reads as no update).
 */
export function updateLine(
  numbers: ProjectNumbers,
  when: (unix: number) => string,
): string {
  const last = numbers.streaks?.updates
    ? numbers.streaks.updates.lastAt
    : numbers.clock.lastCheckIn > numbers.launchedAt
      ? numbers.clock.lastCheckIn
      : null;
  const said = last === null ? "No update yet." : `Last update ${when(last)}.`;
  const run = numbers.streaks
    ? streakLine(numbers.streaks.updates.weeks)
    : null;
  return run ? `${said} ${run}.` : said;
}

/** The door, as a chip. */
export function doorChip(numbers: ProjectNumbers): string {
  return numbers.door.openNow ? "Open to back" : "Closed to new backers";
}

export const ESTABLISHED = "Established";
export const ESTABLISHED_SHEET_TITLE = "What “Established” means";
export const ESTABLISHED_HINT =
  "Established is a hint. It is not a promise, and it changes nothing about your money.";
/** The "Established" line in Details for a record from a server that does not say. */
export const ESTABLISHED_UNTOLD = "This server has not told us yet.";
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
          text: `At least ${e.rule.minAccounts} people back it: not known yet.`,
        }
      : e.accounts >= e.rule.minAccounts
        ? {
            met: true,
            text: `At least ${e.rule.minAccounts} people back it: ${e.accounts} do now.`,
          }
        : {
            met: false,
            text: `Not yet: at least ${e.rule.minAccounts} people need to back it, and ${e.accounts} do now.`,
          };
  const run = e.twoSigners
    ? { met: true, text: "Two people run it." }
    : { met: false, text: "One person runs it. Not yet: it needs two." };
  return [stayed, people, run];
}

/** "Numbers as of 18 Nov, 14:05". */
export function asOfLine(numbers: ProjectNumbers): string {
  return `Numbers as of ${timeText(numbers.asOf.time)}`;
}
