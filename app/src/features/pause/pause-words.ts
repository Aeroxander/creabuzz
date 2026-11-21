/**
 * Every sentence of the holder pause (docs/next-version/STEP4-PLAN.md, section 5), as pure functions of the numbers they
 * speak of, so the card, the sheets and the team's lines say the same thing and one test walks them all.
 *
 * Rules the words keep: "a third" is said only where the line really is one third (`lineDivisor` 3), otherwise "1 in n";
 * the wait is rendered from the pause's own day, never typed as "24 hours"; a percent is rounded down and never reads as the
 * line while it is under it; no sentence says or implies that parking stops a loss; and no sentence says the stop cannot
 * be lost (a join can lower the parked share and end a pause: the card says so).
 */
import { timeText } from "../money/numbers";
import { sharesWords } from "../pot/pot-words";

const SHARE = 1_000_000_000_000_000_000n;

/** "a third" for a line of one third, otherwise "1 in {n}". */
export function lineWords(divisor: number): string {
  return divisor === 3 ? "a third" : `1 in ${divisor}`;
}

/** The line's words at the start of a sentence: "A third", "1 in 5". */
function lineWordsCap(divisor: number): string {
  const text = lineWords(divisor);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The warning period in plain words: "one day" at a day, otherwise the span ("4 minutes" on a demo network). */
export function waitWords(seconds: number): string {
  const plural = (n: number, unit: string) =>
    n === 1 ? `1 ${unit}` : `${n} ${unit}s`;
  if (seconds === 86_400) return "one day";
  if (seconds < 60) return plural(Math.max(1, Math.round(seconds)), "second");
  if (seconds < 3_600) return plural(Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return plural(Math.round(seconds / 3_600), "hour");
  return plural(Math.round(seconds / 86_400), "day");
}

/** `n` as a percent of `d`, rounded down to one decimal, as a number in tenths of a percent (333 is 33.3%). */
function tenths(n: bigint, d: bigint): bigint {
  return d === 0n ? 0n : (n * 1_000n) / d;
}

/**
 * The parked part of the backers' Shares as a percent, rounded down to one decimal ("33.2%"); "none" for nothing; "less than
 * 1%" under 1%. When `parked` is under the line but would round to the line's own figure, it reads "just under {line}" so a
 * person never reads the line while it is not reached.
 */
export function parkedPercent(
  parked: bigint,
  backers: bigint,
  divisor: number,
): string {
  if (parked <= 0n || backers <= 0n) return "none";
  const line = (backers + BigInt(divisor) - 1n) / BigInt(divisor);
  const t = tenths(parked, backers);
  if (parked < line && t >= tenths(line, backers))
    return `just under ${lineWords(divisor)}`;
  if (t < 10n) return "less than 1%";
  const whole = t / 10n;
  const tenth = t % 10n;
  return tenth === 0n ? `${whole}%` : `${whole}.${tenth}%`;
}

/** The sentence "{x} of backers' Shares are parked." with `x` as above. */
function parkedOfBackers(
  parked: bigint,
  backers: bigint,
  divisor: number,
): string {
  const x = parkedPercent(parked, backers, divisor);
  if (x === "none") return "None of backers' Shares are parked.";
  if (x.startsWith("just under"))
    return `Just under ${lineWords(divisor)} of backers' Shares are parked.`;
  return `${x.charAt(0).toUpperCase()}${x.slice(1)} of backers' Shares are parked.`;
}

/** "{n} Shares" for a whole number of Shares rounded up, so a part of a Share is never said as none. */
function sharesCeil(raw: bigint): string {
  return sharesWords(((raw + SHARE - 1n) / SHARE) * SHARE);
}

// --- The card on the project page ------------------------------------------------------------------------------------------

export const PAUSE_HEADING = "Holders can pause the team's spending.";

/** The one line the project's info carries when the card itself is not shown. */
export function infoLine(divisor: number): string {
  return `Holders can pause the team's spending: ${lineWords(divisor)} of Shares parked.`;
}

/** The card's explanation under its heading. */
export function cardIntro(divisor: number, dayLength: number): string {
  return `If ${lineWords(divisor)} of all backers' Shares are parked, the team's daily allowance and new task plans pause ${waitWords(dayLength)} later, for as long as that much stays parked. Parking does not move anyone's money. You can take your money out any time.`;
}

/** Said in the card because the contract allows it. */
export const JOIN_LOWERS =
  "More Shares joining can lower the parked share and end a pause.";

/** Whether the pause is under the line, armed (a warning day running) or on, from the record's own numbers. */
export type PauseStage = "under" | "armed" | "paused";

export function pauseStage(pause: {
  armedAt: number | null;
  paused: boolean;
}): PauseStage {
  return pause.paused ? "paused" : pause.armedAt !== null ? "armed" : "under";
}

/** The card's one state line. */
export function stateLine(pause: {
  stage: PauseStage;
  parkedTotal: bigint;
  backers: bigint;
  lineDivisor: number;
  pausesFrom: number | null;
  since: number | null;
  line: bigint;
}): string {
  const d = pause.lineDivisor;
  if (pause.stage === "armed" && pause.pausesFrom !== null)
    return `${lineWordsCap(d)} is parked. The team's allowance and new task plans pause on ${timeText(pause.pausesFrom)} if it stays there.`;
  if (pause.stage === "paused") {
    const since = pause.since !== null ? ` since ${timeText(pause.since)}` : "";
    const ends = pause.parkedTotal - pause.line + 1n;
    return `Paused${since}. The team cannot draw its allowance or plan new tasks while ${lineWords(d)} stays parked. Tasks already planned go on. Everyone can still take their money out. It ends when ${sharesCeil(ends)} fewer Shares are parked.`;
  }
  return `${parkedOfBackers(pause.parkedTotal, pause.backers, d)} ${lineWordsCap(d)} is needed.`;
}

/** The meter's text value (never colour alone). */
export function meterText(
  parked: bigint,
  backers: bigint,
  divisor: number,
): string {
  const x = parkedPercent(parked, backers, divisor);
  return x === "none"
    ? `None parked, ${lineWords(divisor)} needed`
    : `${x.startsWith("just") ? x : `${x} parked`}, ${lineWords(divisor)} needed`;
}

// --- Your Shares ---------------------------------------------------------------------------------------------------------------

export function parkedLine(parked: bigint, total: bigint): string {
  return `${sharesWords(parked)} of your ${sharesWords(total)} Shares are parked.`;
}

export const PARK_BUTTON = "Park Shares";
export const TAKE_BACK = "Take back";

export function takeBackAsk(parked: bigint): string {
  return `Take back ${sharesWords(parked)} Shares to your wallet. Nothing is charged.`;
}

/** The same ask for a passkey account: where the Shares go is "your account". */
export function takeBackAskAccount(parked: bigint): string {
  return `Take back ${sharesWords(parked)} Shares to your account. Nothing is charged.`;
}

export const TAKE_BACK_DONE = "Taken back. The Shares are yours to use again.";

// --- The Park sheet ------------------------------------------------------------------------------------------------------------

export const PARK_TITLE = "Park Shares";
export const PARK_FIRST =
  "Parked Shares count toward pausing the team's spending. They stay yours: take them back or take them out any day.";
export const PARK_ONE_PRESS = "In one press.";
export const PARK_PASSKEY = "Your passkey is asked once.";
export const PARK_WALLET =
  "Your wallet is asked twice: first to let the project hold them, then to park.";
export const PARK_SECOND =
  "Parking does not move your money. Parked Shares cannot be sent until you take them back.";
export const PARK_DONE =
  "Parked. You can take them back or take them out any time from Your Shares.";
export const PARK_CANNOT_READ =
  "The stop could not be read right now, so nothing can be parked. Your Shares and your Take out are not affected. Try again in a moment.";
export const PARK_NONE = "You hold no Shares in your wallet to park.";

export function parkSummary(input: {
  n: bigint;
  parkedAfter: bigint;
  backers: bigint;
  divisor: number;
  dayLength: number;
}): string {
  const x = parkedPercent(input.parkedAfter, input.backers, input.divisor);
  return `You park ${sharesWords(input.n)} Shares. After this, ${x} of backers' Shares are parked. At ${lineWords(input.divisor)}, the team's allowance and new task plans pause ${waitWords(input.dayLength)} later.`;
}

// --- Take out with parked Shares -----------------------------------------------------------------------------------------------

export function holdingWithParked(total: bigint, parked: bigint): string {
  return `${sharesWords(total)} Shares (${sharesWords(parked)} parked)`;
}

export const TAKE_OUT_UNPARKS =
  "Taking out takes your parked Shares back first, in the same press.";
export const TAKE_OUT_TWICE = "Your wallet is asked twice.";

// --- What the team sees --------------------------------------------------------------------------------------------------------

export function teamArmed(divisor: number, pausesFrom: number): string {
  return `Holders have parked ${lineWords(divisor)} of all Shares. Your allowance and new task plans pause on ${timeText(pausesFrom)} if it stays there. Until then you can draw what the box holds.`;
}

export function teamPaused(divisor: number, since: number | null): string {
  const when = since !== null ? ` since ${timeText(since)}` : "";
  return `Paused by holders${when}. You cannot draw the allowance or plan a new task until fewer than ${lineWords(divisor)} of Shares are parked. You can still check in, finish tasks already planned, grant Team Shares and hand over.`;
}

export const HELPERS_PAUSED =
  "Helpers cannot draw while the team's spending is paused.";

/** The sentence on the Launch sheet and in the Start flow when the deployment has the pause. */
export function launchSentence(divisor: number): string {
  return `On this network holders can pause the team's spending when ${lineWords(divisor)} of Shares are parked. You cannot turn this off for your project.`;
}
