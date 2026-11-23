/**
 * Whether a runner's step is already waiting where it must be agreed to (a Pair's other signer, or the Council's other
 * seats). Asking the same step twice would run it twice: the Pair and the Council both give every proposal its own id,
 * so two identical asks are two calls. The press that moves money reads this first and says so instead of sending
 * (`pot-words.ts` has the words). One place for the readers so every money press guards itself the same way.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import type { ProjectNumbers } from "../money/numbers";
import type { Ready } from "./use-pot";
import { readCouncilWaiting } from "../council/waiting-read";
import { readPairWaiting } from "./use-pair-waiting";

/** The exact call (same target and bytes), in the runner's waiting list now. Throws when what waits cannot be read. */
export async function alreadyAsked(
  ready: Ready,
  numbers: ProjectNumbers,
  through: "pair" | "council",
  inner: PotCall,
): Promise<boolean> {
  const waiting =
    through === "pair"
      ? (
          await readPairWaiting(
            ready,
            numbers.runner.address,
            numbers.contracts.treasury,
          )
        ).waiting
      : numbers.council
        ? (await readCouncilWaiting(ready, numbers.council.contract)).waiting
        : [];
  return waiting.some(
    (w) =>
      w.target === inner.to.toLowerCase() &&
      w.data === inner.data.toLowerCase(),
  );
}
