/**
 * The words and numbers of the launch sheet: the two starting numbers every project launches with (the daily allowance and
 * the Team pool; the founder is not asked for them), the limits that are the same for every project, and what can and cannot
 * be changed after the launch. Pure: no screen, no chain read. The limits are said from what the Launcher and the contracts
 * it makes projects from gave (`LaunchOffer`), never from numbers kept here.
 */
import type { LaunchOffer } from "@creaton/core/pot/pot-state.ts";
import { dollarsText } from "../money/numbers";
import { rateWords, sharesWords, spanOf } from "../money/copy";

const SHARE = 1_000_000_000_000_000_000n;

/** The two numbers a launch carries, as the call carries them. */
export interface LaunchTerms {
  ratePpm: number;
  teamPool: bigint;
}

/** What every project starts with: 0.10% of its money a day (1,000 parts per million) and 10,000,000 Team Shares. */
const STARTING_TERMS: LaunchTerms = {
  ratePpm: 1000,
  teamPool: 10_000_000n * SHARE,
};

/** The starting numbers, or null when the platform's own ceilings sit under them (then a launch would be refused). */
export function launchTermsFor(
  offer: Pick<LaunchOffer, "maxRatePpm" | "maxTeamPool">,
): LaunchTerms | null {
  return STARTING_TERMS.ratePpm <= offer.maxRatePpm &&
    STARTING_TERMS.teamPool <= offer.maxTeamPool
    ? STARTING_TERMS
    : null;
}

/** "0.001", "1", "2.5": a number with its trailing zeros dropped, at most three decimals. */
function plainNumber(value: number): string {
  return String(Number(value.toFixed(3)));
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
    can: `You can still lower the daily allowance at once, raise it (that waits ${spanOf(offer.unit)} and everyone can see it first), or close the door to new backing.`,
  };
}

/** The sentence that says what pressing will send: the same two numbers the call carries. */
export function launchTermsSentence(name: string, terms: LaunchTerms): string {
  return `${name} will be put on the network with a daily allowance of ${rateWords(terms.ratePpm)} of the project's money and a Team pool of ${sharesWords(terms.teamPool)} Team Shares.`;
}

/** What the sheet says when the settings hash it read is not the one the Launcher has at the signature. */
export const SETTINGS_MOVED_WORDS =
  "Creaton's settings changed while you were deciding. Nothing was sent. The new settings are shown again; read them and press again.";
