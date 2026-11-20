/**
 * The sentences of the task queue that more than one screen says (plan section 5, 1.6 and 4.7): the words about a record that
 * is old or missing, the two lines a planned task carries for everyone, the line for a task that was taken or ended, why a
 * task does not tie to the team's record, what stops an accept, and the four sentences a Pair's second signer reads. Pure.
 * The words of every contract refusal live in `money/pot-copy.ts`, not here; a sentence that only one screen says is in
 * that screen's own words file.
 *
 * Every sentence says what happened and what to do next, uses the plain words ("Back", "Take out", "the project's money"),
 * names no event, code or contract, and money screens say plainly that the dollars are play money (the sheet carries that
 * line itself).
 */
import {
  dayText,
  type Freshness,
  freshnessOf,
  type ProjectNumbers,
  timeText,
} from "../../money/numbers";
import { dollarsPhrase, percentOfBps } from "../../money/pot-copy-tasks";
import { exactDollarsText } from "../../pot/pot-words";
import { TASK_PROBLEM } from "../tasks-copy";
import type { Phase, Tie } from "./state";
import type { ChainTask } from "./types";

// --- Amounts and the team's own words -----------------------------------------------------------------------------

export { dollarsPhrase, percentOfBps };

/** The longest a task's own words are shown in a sentence about it. */
export const WORDS_MAX = 80;

/** Control and format characters (direction marks, zero-width marks and the like), which a sentence about a task never carries. */
const CONTROLS = /[\p{Cc}\p{Cf}]/gu;

/**
 * A task's own words inside a sentence: “…”, whitespace made plain, quotes and direction marks taken out, cut at
 * `WORDS_MAX` characters. Always a plain text node. With no words (the plan does not tie to a record here) it is "a task".
 */
export function quotedWhat(words: string | null | undefined): string {
  const plain = (words ?? "")
    .replace(CONTROLS, " ")
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (plain === "") return "a task";
  const cut =
    plain.length > WORDS_MAX ? `${plain.slice(0, WORDS_MAX - 1)}…` : plain;
  return `“${cut}”`;
}

// --- A record that is missing, unreadable or old (1.6) -------------------------------------------------------------

/** The Tasks tab when the server wrote no queue (an older server, or a project with no task book), once. */
export const TASKS_NOT_TOLD =
  "This server has not told us about this project's tasks yet.";

/** The Tasks tab when the queue is there and could not be read. */
export const TASKS_UNREADABLE =
  "The task list could not be read. Your money is not affected: you can take it out any time.";

/**
 * Why the queue screens are hidden, or null when they show: no queue at all (absent or null) reads "not told us yet"; a
 * queue that did not parse reads "could not be read". Either way leaving is not in question.
 */
export function queueLine(tasks: ProjectNumbers["tasks"]): string | null {
  if (tasks === undefined || tasks === null) return TASKS_NOT_TOLD;
  if (tasks === "unreadable") return TASKS_UNREADABLE;
  return null;
}

/** "as of 18 Nov, 14:05": the time of the record, for a date or state on a list. */
export function asOfWords(asOf: number): string {
  return `as of ${timeText(asOf)}`;
}

/** The Tasks tab when the record is over a day old: what is missing and that money is not affected. */
export function tasksStaleWords(asOf: number): string {
  return `We have not been able to refresh this project's tasks since ${dayText(asOf)}. Your money is not affected: you can take it out any time.`;
}

/**
 * What a task's date or state carries when the record is old, or null when it is fresh: "as of {time}" past three refresh
 * periods, and past a day "as of {date}. This may be out of date: the server has not refreshed this project since."
 * A state is never carried forward from an old record into a button: a press reads the chain.
 */
export function ageNote(freshness: Freshness, asOf: number): string | null {
  if (freshness.level === "fresh") return null;
  if (freshness.level === "as-of") return asOfWords(asOf);
  return `as of ${dayText(asOf)}. This may be out of date: the server has not refreshed this project since.`;
}

/** The age note of a record at `now` (the one clock): null while it is fresh. */
export function ageNoteOf(numbers: ProjectNumbers, now: number): string | null {
  return ageNote(freshnessOf(numbers, now), numbers.asOf.time);
}

// --- Where a task is, in a few words (for a sentence about a task that moved) -----------------------------------

const PHASE_WORD: Record<Phase, string> = {
  notice: "planned, and not open to be taken yet",
  open: "planned, and it can be taken",
  missed: "lapsed, because nobody took it in time",
  working: "taken",
  overdue: "past its deadline",
  paid: "already paid",
  "sent-back": "sent back",
  "ran-out": "ran out",
  withdrawn: "withdrawn",
  lapsed: "lapsed",
  "wound-down": "closed when the project wound down",
};

/** A phase in a few plain words, for "it is now {…}". */
export function phaseWord(phase: Phase): string {
  return PHASE_WORD[phase];
}

/** After the press was read again: the task is not what the sheet showed. */
export function changedWhileLooking(phase: Phase): string {
  return `This task changed while you were looking: it is now ${phaseWord(phase)}. Nothing was sent. Close this and open it again.`;
}

/** A sheet that needs a task holding money, shown one that is not. */
export function notHoldingMoney(phase: Phase): string {
  return `This task is not holding money: ${phaseWord(phase)}.`;
}

// --- A planned task, in two lines, and one line for the rest (5.3) ----------------------------------------------

/** The two lines every holder sees about a planned task, signed in or not (T5). `open` is true once it can be taken. */
export function plannedLines(input: {
  max: bigint;
  /** The pay-to's name, or null for "whoever takes it". */
  name: string | null;
  /** The task record's words when the plan ties to a record here, else null ("a task"). */
  what: string | null;
  /** `noticeEnd` while it cannot be taken yet, `expiresAt` once it can. */
  date: number;
  open: boolean;
}): [string, string] {
  const who = input.name ?? "whoever takes it";
  const head = `The team plans to pay up to ${dollarsPhrase(input.max)} to ${who} for ${quotedWhat(input.what)}`;
  return [
    input.open
      ? `${head}. It can be taken until ${timeText(input.date)}.`
      : `${head}, from ${timeText(input.date)}.`,
    // Before it can be taken the date is the day to leave by; once it can be taken, leaving works on any day (the news says so too).
    `${input.open ? "You can take your money out any time." : "You can take your money out before then."} ${dollarsPhrase(input.max)} is the most; it can be less if people take out first.`,
  ];
}

/** "{x} dollars would be set aside today (a share of the project's money)." under a planned task, from the record's row. */
export function atMostNowLine(atMostNow: bigint): string {
  return `${dollarsPhrase(atMostNow)} would be set aside today (a share of the project's money).`;
}

/**
 * One line about a task that is taken or has ended (the alert kinds of section 6 say the same): who took it and what is set
 * aside, what was paid, or that nothing moved. `phase` comes from `phaseOf` (which knows about a wind-down sweep).
 */
export function endedLine(input: {
  task: ChainTask;
  phase: Phase;
  name: string | null;
  what: string | null;
}): string {
  const { task, phase } = input;
  const what = quotedWhat(input.what);
  switch (phase) {
    case "working":
      return `${input.name ?? "Someone"} took ${what}. ${dollarsPhrase(task.setAside)} ${task.setAside === 1_000_000n ? "is" : "are"} set aside until ${timeText(task.deadline ?? task.expiresAt)}.`;
    case "paid":
      return task.pay < task.setAside
        ? `${what} was paid ${dollarsPhrase(task.pay)} of the ${dollarsPhrase(task.setAside)} set aside; the rest went back.`
        : `${what} was paid ${dollarsPhrase(task.pay)}.`;
    case "sent-back":
      return `${what} was sent back. Nothing was paid; the money went back to the project.`;
    case "ran-out":
    case "overdue":
      return `${what} ran out. Nothing was paid; the money went back.`;
    case "withdrawn":
      return `The plan for ${what} was withdrawn.`;
    case "lapsed":
    case "missed":
      return `Nobody took ${what} in time, so it lapsed. Nothing moved.`;
    case "wound-down":
      return `The plan for ${what} closed when the project wound down. Nothing was paid.`;
    default:
      return `The team plans ${what}.`;
  }
}

// --- Why a plan does not tie to the team's record, and what stops an accept (4.4, 5.5) ----------------------------

type TieWhy = Extract<Tie, { ok: false }>["why"];

/** Each failed tie in a few words, for "(… )" inside a sentence. */
const TIE_REASON: Record<TieWhy, string> = {
  "no-record": "it is not on this project's task list",
  what: "it names another task",
  closed: "the task was stopped or given up here",
  "already-paid": "it was already paid here",
  amount: "the pay is not the same",
  payee: "the wallet it names is not the one the worker named",
  taker: "the wallet that took it is not the one the worker named",
  repeat: "it was planned more than once",
  "worker-left": "the person who took it gave it up",
  "not-taken": "nobody has agreed to do it here yet",
};

/** The reason a plan does not tie, in a few plain words. */
export function tieReason(why: TieWhy): string {
  return TIE_REASON[why];
}

/** The network has the task in another state than "taken". */
export function notWaitingForPay(phase: Phase): string {
  return `This task is not waiting for payment on the network: ${phaseWord(phase)}. Nothing can be paid.`;
}

/** The deadline passed (or is within the room a press needs): the money goes back and nothing can be paid. */
export function deadlinePassed(deadline: number, now: number): string {
  return now >= deadline
    ? `The deadline passed on ${timeText(deadline)}. The money goes back to the project and cannot be paid now.`
    : `The deadline, ${timeText(deadline)}, is too close to pay this safely: if it passes first, the money goes back to the project and nothing is paid. You can send the money back.`;
}

/** The wallet that took the task on the network is not the one the worker named here. */
export function takerDiffers(onNetwork: string, named: string | null): string {
  return `The network says this task was taken by ${onNetwork}, but the person who took it here named ${named ?? "no wallet"} to be paid. Nothing can be paid until they match. You can send the money back.`;
}

/** A plan that does not tie in some other way. */
export function notThisTask(why: TieWhy): string {
  return `This plan on the network is not for this task as it was written here (${tieReason(why)}), so it cannot be paid from here. You can send the money back.`;
}

/** The same task record was planned more than once: only the first can be paid. */
export function plannedMoreThanOnce(first: bigint): string {
  return `This task was planned more than once on the network (task ${first} came first), so only the first can be paid. You can send this money back.`;
}

/** Nothing is set aside, so nothing can be paid. */
export const NOTHING_SET_ASIDE =
  "Nothing is set aside for this task, so nothing can be paid.";

/** The sender may not accept this work (their own, or an agent they run) or does not run the project. */
export const OWN_WORK = TASK_PROBLEM.ownWork;
export const NOT_RUNNER = TASK_PROBLEM.notRunner;

// --- A Pair's second signer reads these four (4.7) --------------------------------------------------------------

/** What a waiting call that names a task says when the task's details could not be read: it is never offered to confirm. */
export const UNKNOWN_TASK_WORDS =
  "This is about a task whose details could not be read from the network, so it cannot be confirmed from here. Try again in a moment.";

/** Under the plan sentence: the date it names moves if the second signer confirms late (the proposal lives two units). */
export const DATE_COUNTS_FROM_CONFIRM =
  "The date counts from when you confirm.";

/** "Plan a task: ..." (`who` is "{name} ({address})", or null for whoever takes it first). */
export function announceTaskWords(input: {
  max: bigint;
  who: string | null;
  shareBps: number;
  notice: string;
  /** "if confirmed now" plus the notice. */
  from: number;
  window: string;
  due: string;
}): string {
  return `Plan a task: pay up to ${dollarsPhrase(input.max)} to ${input.who ?? "whoever takes it first"}, at most ${percentOfBps(input.shareBps)} of the project's money. Holders get ${input.notice} notice, so it can be taken from ${timeText(input.from)}; if nobody takes it within ${input.window} it lapses; once taken it is due ${input.due} later.`;
}

/** An amount exactly as a call carries it, never rounded: "1 dollar", "57.486851 dollars". */
const exactPhrase = (raw: bigint): string =>
  raw === 1_000_000n ? "1 dollar" : `${exactDollarsText(raw)} dollars`;

/**
 * "Pay {pay} of the {set aside} set aside for task {serial} to {takenBy}..." The amounts are exact: the other signer confirms
 * what the call moves, so "pay it all" of 57.486851 dollars reads 57.486851, not a figure rounded down to the cent.
 */
export function acceptTaskWords(input: {
  pay: bigint;
  setAside: bigint;
  serial: bigint;
  who: string;
}): string {
  return `Pay ${exactPhrase(input.pay)} of the ${exactPhrase(input.setAside)} set aside for task ${input.serial} to ${input.who}. What is left goes back to the project and to those who took out while it was set aside.`;
}

/** "Send task {serial}'s money back. Nobody is paid." */
export function rejectTaskWords(serial: bigint): string {
  return `Send task ${serial}'s money back. Nobody is paid.`;
}

/** "Withdraw task {serial}. It was not taken, so no money moves." */
export function cancelTaskWords(serial: bigint): string {
  return `Withdraw task ${serial}. It was not taken, so no money moves.`;
}

/** A waiting call names a task that is no longer in the state the call works on: it cannot be confirmed any more. */
export function pairTaskMoved(serial: bigint, phase: Phase): string {
  return `This call is about task ${serial}, which has changed since it was asked: it is now ${phaseWord(phase)}. It cannot be confirmed any more. Whoever asked can withdraw it.`;
}

/** The line under a Pair sentence when the task's `what` ties to a task record here. */
export function theTaskWords(words: string): string {
  return `The task: ${quotedWhat(words)}`;
}
