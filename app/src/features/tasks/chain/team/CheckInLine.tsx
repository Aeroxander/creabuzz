/** The line every reader sees on a planned task whose plan cannot be taken unless the team checks in. */
import { type ProjectNumbers, timeText } from "../../../money/numbers";
import type { ChainTask } from "../types";
import { cannotBeTaken } from "./check-in";

/** On a task's card, for everyone: this plan cannot be taken unless the team checks in before the date. */
export function NotTakeableLine({
  row,
  numbers,
  now,
}: {
  row: ChainTask;
  numbers: ProjectNumbers;
  now: number;
}) {
  const until = numbers.clock.activeUntil;
  if (until === null || numbers.windDown || !cannotBeTaken(row, until, now))
    return null;
  return (
    <p className="text-sm" data-testid="task-not-takeable">
      This task cannot be taken unless the team checks in before{" "}
      {timeText(until)}.
    </p>
  );
}
