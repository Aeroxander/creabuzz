/**
 * The words and numbers of the launch sheet: the two starting numbers every project launches with (the daily allowance and
 * the Team pool; the founder is not asked for them) and the platform's fee when it takes one. Pure: no screen, no chain
 * read.
 */
import type { LaunchOffer } from "@creaton/core/pot/pot-state.ts";
import { rateWords, sharesWords } from "../money/copy";

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

/** What Creaton takes from the money people put in, as a sentence, or null when it takes nothing. */
export function feeSentence(feeBps: number): string | null {
  return feeBps > 0
    ? `Creaton takes ${plainNumber(feeBps / 100)}% of the money people put in.`
    : null;
}

/** The sentence that says what pressing will send: the same two numbers the call carries. */
export function launchTermsSentence(terms: LaunchTerms): string {
  return `The team may take ${rateWords(terms.ratePpm)} of the project's money a day. Team pool: ${sharesWords(terms.teamPool)} Team Shares. You sign once.`;
}

/** What the sheet says when the settings hash it read is not the one the Launcher has at the signature. */
export const SETTINGS_MOVED_WORDS =
  "Creaton's settings changed while you were deciding. Nothing was sent. The new settings are shown again; read them and press again.";
