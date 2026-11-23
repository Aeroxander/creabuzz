/**
 * The words and numbers of the launch sheet: the founder's two numbers (the daily allowance and the Team pool) with their
 * defaults, what a typed value means and why one is refused, what each means for a backer, the limits that are the same
 * for every project, and what can and cannot be changed after the launch. Pure: no screen, no chain read. The limits are
 * said from what the Launcher and the contracts it makes projects from gave (`LaunchOffer`), never from numbers kept here.
 */
import type { LaunchOffer } from "@creaton/core/pot/pot-state.ts";
import { dollarsText } from "../money/numbers";
import { parseRate } from "../pot/AllowanceSheets";
import { rateWords, sharesWords, spanOf } from "../pot/pot-words";

export { spanOf };

const SHARE = 1_000_000_000_000_000_000n;

/** The allowance the sheet starts with: 0.10% of the project's money a day (1,000 parts per million). */
const DEFAULT_RATE_TEXT = "0.10";
/** The Team pool the sheet starts with: 10,000,000 Team Shares. */
const DEFAULT_POOL_TEXT = "10,000,000";

/** What is typed on the sheet. */
export interface LaunchDraft {
  rate: string;
  pool: string;
}

export const DEFAULT_LAUNCH_DRAFT: LaunchDraft = {
  rate: DEFAULT_RATE_TEXT,
  pool: DEFAULT_POOL_TEXT,
};

/** The two numbers as the call carries them, or what is wrong with each box. */
export type LaunchTerms =
  | { ok: true; ratePpm: number; teamPool: bigint }
  | { ok: false; rate: string | null; pool: string | null };

/** A whole number of Team Shares typed by a person (commas allowed), as raw units; null when it is not one. */
function parsePool(text: string): bigint | null {
  const m = /^\d{1,12}$/.exec(text.trim().replace(/,/g, ""));
  return m ? BigInt(m[0]) * SHARE : null;
}

/** Read the two boxes against the Launcher's ceilings. */
export function readLaunchTerms(
  draft: LaunchDraft,
  offer: Pick<LaunchOffer, "maxRatePpm" | "maxTeamPool">,
): LaunchTerms {
  const ppm = parseRate(draft.rate);
  const pool = parsePool(draft.pool);
  const rate =
    draft.rate.trim() === ""
      ? "Write a percent a day, like 0.10. Write 0 to switch the allowance off."
      : ppm === null
        ? "Write a percent a day, like 0.10."
        : ppm > offer.maxRatePpm
          ? `The most it can be is ${rateWords(offer.maxRatePpm)} a day.`
          : null;
  const poolProblem =
    draft.pool.trim() === ""
      ? "Write a number of Team Shares, like 10,000,000. Write 0 for none."
      : pool === null
        ? "Write a whole number of Team Shares, like 10,000,000."
        : pool > offer.maxTeamPool
          ? `The most is ${sharesWords(offer.maxTeamPool)} Team Shares.`
          : null;
  if (rate !== null || poolProblem !== null || ppm === null || pool === null)
    return { ok: false, rate, pool: poolProblem };
  return { ok: true, ratePpm: ppm, teamPool: pool };
}

/** "0.001", "1", "2.5": a number with its trailing zeros dropped, at most three decimals. */
function plainNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** For a backer: what the allowance is, in a sentence. */
export function allowanceForBackers(ratePpm: number): string {
  if (ratePpm === 0)
    return "For backers: the allowance is switched off, so the team draws nothing from the project's money by this route.";
  const perThousand = plainNumber(ratePpm / 1000);
  return `For backers: the team can draw at most ${rateWords(ratePpm)} of the project's money a day (${perThousand} ${perThousand === "1" ? "dollar" : "dollars"} of every 1,000 it holds). It is a share of what is left, so it shrinks as money goes out, and backers can take their money out any day.`;
}

/** For a backer: what the Team pool is, in a sentence. */
export function poolForBackers(teamPool: bigint): string {
  if (teamPool === 0n)
    return "For backers: there are no Team Shares, so the team has no claim on the project's money beyond the allowance.";
  return `For backers: ${sharesWords(teamPool)} Team Shares are set aside for the people who build this. They only ever claim money above what backers put in, so they can never take a backer's money; if nothing is above it, they are worth nothing.`;
}

/** The limits every project has, in plain words, from what the contracts gave. */
export function fixedLimits(offer: LaunchOffer): string[] {
  const unit = offer.unit;
  const fee = offer.feeBps / 100;
  return [
    `Creaton takes ${plainNumber(fee)}% of the money people put in, and nothing when they take it out.`,
    `The smallest backing is ${dollarsText(offer.rules.minJoin)} ${offer.rules.minJoin === 1_000_000n ? "dollar" : "dollars"}.`,
    `The daily allowance can never go above ${rateWords(offer.maxRatePpm)} of the project's money a day.`,
    `If the team does not check in for ${spanOf(offer.rules.checkInUnits * unit)}, new backing and the allowance stop until it does.`,
    `If it stays quiet for ${spanOf(offer.rules.windDownUnits * unit)}, anyone can wind the project down. Backers can still take their money out.`,
    `A Team Share grant starts to unlock after ${spanOf(offer.rules.cliffUnits * unit)} and has all unlocked after ${spanOf(offer.rules.vestUnits * unit)}, counted only while the team keeps checking in.`,
    `A helper can draw at most ${dollarsText(offer.agentUsd)} dollars a day, and use at most one part in ${offer.agentShareDiv.toLocaleString("en-US")} of the Team pool in Team Shares a day.`,
  ];
}

/** What cannot be changed after the launch, and what can. */
export function afterLaunch(offer: LaunchOffer): {
  cannot: string;
  can: string;
} {
  return {
    cannot:
      "After it is launched you cannot change the size of the Team pool, or any of the limits above.",
    can: `You can still lower the daily allowance at once, raise it (that waits ${spanOf(offer.unit)} and everyone can see it first), close the door to new backing, hand the project to someone, run it with a second person, or wind it down.`,
  };
}

/** The sentence that says what pressing will send: the same two numbers the call carries. */
export function launchTermsSentence(
  name: string,
  terms: Extract<LaunchTerms, { ok: true }>,
): string {
  return `${name} will be put on the network with a daily allowance of ${rateWords(terms.ratePpm)} of the project's money and a Team pool of ${sharesWords(terms.teamPool)} Team Shares.`;
}

/** What the sheet says when the settings hash it read is not the one the Launcher has at the signature. */
export const SETTINGS_MOVED_WORDS =
  "Creaton's settings changed while you were deciding. Nothing was sent. The new settings are shown again; read them and press again.";
