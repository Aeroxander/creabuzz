/**
 * The sentences of the holder's side of a task (plan section 5.3): the strips every reader sees about a planned or running
 * task. Pure. Each says what is so and what to do next, names no event, code or contract. The words of every contract refusal
 * live in `money/problems.ts`; the two lines of a planned task and the line for a task that moved are in `chain/words.ts`.
 */
import { shortAddress } from "../../../../lib/short-address";
import { timeText } from "../../../money/numbers";
import { dollarsPhrase, percentOfBps } from "../words";

// --- The strips and the Money tab (5.3) --------------------------------------------------------------------------------

/** The heading of a strip about a plan, and of one about a task somebody took. */
export const PLANNED_HEADING = "A planned task";
export const RUNNING_HEADING = "A task in progress";

/** The heading of the section on the Money tab. */
export const PLANNED_SECTION = "Planned and running tasks";

/** Under the heading when no task is planned or taken. */
export const NO_TASKS_NOW = "No task is planned or running now.";

/** The button on a strip: a holder can leave before the money moves. It is named for its date, so no two on a page share a name. */
export function takeOutBefore(date: number): string {
  return `Take out before ${timeText(date)}`;
}

/** Once a plan can be taken the money may move at any moment, so the button says now. */
export const TAKE_OUT_NOW = "Take out now";

/** "and 2 more", the press that opens the Money tab when more than three tasks are planned or running. */
export function andMore(count: number): string {
  return `and ${count} more`;
}

/** The money set aside, and the room left for more, in one sentence under the section (the record's own figures). */
export function setAsideAndRoom(input: {
  locked: bigint;
  roomBps: number;
  /** When room comes back, when some is held back now. */
  backAt: number | null;
}): string {
  const aside =
    input.locked === 0n
      ? "No money is set aside for tasks."
      : `Money set aside for tasks: ${dollarsPhrase(input.locked)}.`;
  const room = `Room left for tasks: ${percentOfBps(input.roomBps)} of the project's money for now${
    input.backAt === null ? "" : `; more from ${timeText(input.backAt)}`
  }.`;
  return `${aside} ${room}`;
}

/** The name a task's wallet is shown under when nobody here gave it a name: its start and its end. */
export { shortAddress };
