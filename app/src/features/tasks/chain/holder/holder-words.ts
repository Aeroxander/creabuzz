/**
 * The sentences of the worker's and the holder's side of a task (plan sections 5.3, 5.8 and 5.9): the strips every reader
 * sees about a planned or running task, the Take sheet, and the one press that returns the money of a task that ran out. Pure.
 * Each says what is so and what to do next, names no event, code or contract, and the sheet carries the play-money line and
 * the legal line itself. The words of every contract refusal live in `money/pot-copy.ts`; the two lines of a planned task and
 * the line for a task that moved are in `chain/words.ts`.
 */
import { timeText } from "../../../money/numbers";
import {
  NEW_TASK_ERRORS,
  TASK_EXTENSIONS,
} from "../../../money/pot-copy-tasks";
import { durationWords } from "../duration";
import type { Phase } from "../state";
import { dollarsPhrase, percentOfBps, phaseWord, quotedWhat } from "../words";

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

/** "and 2 more", the press that opens the Tasks tab when more than three tasks are planned or running. */
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
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// --- The Take sheet (5.8) ---------------------------------------------------------------------------------------------

/** On a plan that names nobody (made outside this app): nobody is offered the press. */
export const OPEN_TO_ANYONE =
  "Open to anyone. The team chose not to name who is paid.";

/** Before the notice is over, to the person it is named for: the wait, and no press. */
export function takeWait(from: number): string {
  return `You can take it from ${timeText(from)}.`;
}

/** The press that opens the sheet, and the one inside it. */
export const TAKE_PRESS = "Set the money aside";
/** The opener says the same: the team-side step 1 button on the same card is "Take this task" and must not be confused with it (C34). */
export const TAKE_OPEN = "Set the money aside";
export const TAKE_LOOK = "Look for your step";

export function takeTitle(what: string | null): string {
  return `Set the money aside for ${quotedWhat(what)}`;
}

export function namedLine(max: bigint): string {
  return `You are named for this task: ${dollarsPhrase(max)} at most.`;
}

/** What taking it sets aside now: the smaller of the most and the share of the project's money. */
export function takeAmountLine(input: {
  max: bigint;
  share: string;
  atMost: bigint;
}): string {
  return `Taking it sets money aside for you now: the smaller of ${dollarsPhrase(input.max)} and ${input.share} of the project's money, about ${dollarsPhrase(input.atMost)} today.`;
}

/** What happens after: paid what the team chooses, by the due time, or the money goes back. */
export function takeDueLine(dueSecs: number): string {
  return `If the team accepts your work, you are paid what they choose, up to what is set aside, by ${durationWords(dueSecs)} after you take it. If they do not, the money goes back.`;
}

/** The guard's label (checked by default): nothing is taken if less than the whole most would be set aside. */
export function takeGuard(max: bigint): string {
  return `Take it only if the whole ${dollarsPhrase(max)} is set aside`;
}

/** Under the guard, said for both of its states. */
export function takeGuardHint(checked: boolean, min: bigint): string {
  return checked
    ? "Nothing is taken if less would be set aside."
    : `Unchecked, you accept as little as ${dollarsPhrase(min)}.`;
}

/** The guard is on and the project's money has fallen, so the whole most is no longer set aside: pressing would take nothing. */
export function takeShort(atMost: bigint, max: bigint): string {
  return `Right now about ${dollarsPhrase(atMost)} would be set aside, less than the whole ${dollarsPhrase(max)}. With the box checked, nothing is taken.`;
}

/** After it landed: the first note is said at once, the second once the network's own numbers are read. */
export const TAKEN = "Taken. Hand your work in on the task.";

export function takenWords(setAside: bigint, deadline: number): string {
  return `Taken. ${dollarsPhrase(setAside)} ${setAside === 1_000_000n ? "is" : "are"} set aside for you until ${timeText(deadline)}. Hand your work in on the task.`;
}

/** What the sheet says when what it needs could not be read. */
export const TAKE_READ_FAILED =
  "What taking this task needs could not be read from the network, so nothing can be sent now. Nothing was set aside.";

/** The wallet shows another account than the one the task is named for. */
export function takeNotPayee(payee: string): string {
  return `This task is named for the account ${shortAddress(payee)}. You are using another account, so you cannot take this task here.`;
}

/** Where taking is stopped, one sentence each (the contract's own words where it has them). */
export const TAKE_BLOCK = {
  runs: TASK_EXTENSIONS.NotAllowed["take-task"],
  state: NEW_TASK_ERRORS.WrongTaskState["take-task"],
  over: NEW_TASK_ERRORS.TakeWindowOver.any,
  quiet:
    "The team has not checked in lately, so no task can be taken until they do. Ask the team to check in. Nothing changed.",
  wound: "This project has wound down, so nothing can be taken any more.",
} as const;

/** The notice is still running. */
export function takeNotice(noticeEnd: number): string {
  return NEW_TASK_ERRORS.NoticeRunning.any([BigInt(noticeEnd)]);
}

/** The limit on money set aside for tasks recently leaves no room: when some comes back, if the record says. */
export function takeCap(input: {
  used: number;
  add: number;
  cap: number;
  backAt: number | null;
}): string {
  const words = NEW_TASK_ERRORS.CapReached.any([
    BigInt(input.used),
    BigInt(input.add),
    BigInt(input.cap),
  ]);
  return input.backAt === null
    ? words
    : `${words} Room comes back from ${timeText(input.backAt)}.`;
}

// --- Return the money (5.9) --------------------------------------------------------------------------------------------

export const RETURN_PRESS = "Return the money";
export const RETURN_LOOK = "Look for your return";
export const RETURN_TITLE = "Return the money to the project";
export const RETURNED = "Returned. The money is in the project again.";

/** On a task that ran out, for anyone: nobody was paid and anyone can return the money. */
export function returnLine(deadline: number): string {
  return `The deadline passed on ${timeText(deadline)} and nobody was paid. Anyone can return the money to the project.`;
}

/** What was set aside for the task that ran out. */
export function returnFacts(what: string | null, setAside: bigint): string {
  return `${quotedWhat(what)}: ${dollarsPhrase(setAside)} ${setAside === 1_000_000n ? "is" : "are"} set aside for it.`;
}

/** The task is not waiting to be returned. */
export function notWaitingToReturn(phase: Phase): string {
  return `The money of this task is not waiting to be returned: it is ${phaseWord(phase)}. Nothing changed.`;
}

/** Early: the deadline has not passed on the network yet. */
export function returnNotYet(deadline: number): string {
  return TASK_EXTENSIONS.NotYet["return-task"]([BigInt(deadline)]);
}

/** What the sheet says when what it needs could not be read. */
export const RETURN_READ_FAILED =
  "What returning the money needs could not be read from the network, so nothing can be sent now. Nothing changed.";
