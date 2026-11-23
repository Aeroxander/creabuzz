/**
 * The one line under a runner sheet's terms that says who else must agree before the step happens: nothing for the
 * runner alone, the Pair's own words for a signer, and the Council's words from the record's own numbers for a seat.
 * Every runner sheet draws it, so no two sheets word the ask differently.
 */
import { proposeAskLine } from "../council/council-words";
import type { ProjectNumbers } from "../money/numbers";
import { PAIR_WORDS, type RunnerSend } from "./runner-calls";

export function RunnerAskNote({
  numbers,
  through,
}: {
  numbers: ProjectNumbers;
  through: RunnerSend["through"] | undefined;
}) {
  if (through === "pair")
    return (
      <p className="text-sm text-muted" data-testid="runner-ask">
        {PAIR_WORDS}
      </p>
    );
  if (through === "council") {
    const council = numbers.council;
    if (!council) return null;
    return (
      <p className="text-sm text-muted" data-testid="runner-ask">
        {proposeAskLine(council.needed, council.seats.length)}
      </p>
    );
  }
  return null;
}
