/**
 * A runner-only call (draw, rate, door, grant) as this account sends it, with the words for who has to say yes: straight
 * to the Treasury for the runner, a proposal through the Pair for one of its two signers (the other signs next), a
 * proposal through the Council for one of its seats (the needed seats agree, then it runs), or nothing for anyone else.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import type { ProjectNumbers } from "../money/numbers";
import { asRunner } from "../money/runner";

export interface RunnerSend {
  calls: PotCall[];
  through: "alone" | "pair" | "council";
}

export function runnerSend(
  numbers: ProjectNumbers,
  me: string,
  inner: PotCall,
): RunnerSend | null {
  const sent = asRunner(numbers, me, inner);
  return sent ? { calls: [sent.call], through: sent.through } : null;
}

/** What a runner sheet says when a Pair runs the project: nothing happens until the other signer confirms. */
export const PAIR_WORDS =
  "This project is run by two. Pressing asks the other signer: nothing happens until they confirm the same step.";

/**
 * The note when a check-in landed. Either signer of a Pair may check in alone, so only a Council's seat was asking
 * first (`checkInRoute`, `money/runner.ts`).
 */
export function checkInDoneWords(through: "now" | "ask"): string {
  return through === "ask"
    ? doneWords("council", "")
    : "Checked in. The allowance keeps running.";
}

/** The note shown when it landed: who has to say yes next. */
export function doneWords(
  through: RunnerSend["through"],
  done: string,
): string {
  if (through === "pair")
    return "Asked. It happens when the other signer confirms.";
  if (through === "council") return "Asked. It runs when enough seats agree.";
  return done;
}
