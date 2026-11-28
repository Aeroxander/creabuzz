/**
 * The sentences of the top of a project's page, made from the signed record and nothing else. Pure, so one test holds every
 * sentence.
 */
import type { ProjectNumbers } from "../money/numbers";
import { timeText } from "../money/numbers";
import { smallDollarsText } from "../money/copy";

/** What the money line says about what a take-out would give: the figure of the same name on the Take out sheet. */
export function takeOutNowLine(numbers: ProjectNumbers): string {
  return `Taking out now gives ${smallDollarsText(numbers.value.leaveValue)} per Share.`;
}

/** "Numbers as of 18 Nov, 14:05". */
export function asOfLine(numbers: ProjectNumbers): string {
  return `Numbers as of ${timeText(numbers.asOf.time)}`;
}
