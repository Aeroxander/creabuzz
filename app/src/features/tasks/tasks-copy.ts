/**
 * The words of the Tasks tab: what each state says, and every problem a task step can meet as a sentence that says
 * what happened and what to do next. Money problems come from `moneyProblem`; this adds the steps that are records.
 */
import { dollarsText } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import type { TaskState } from "./task-record";

export const STATE_WORDS: Record<TaskState, string> = {
  open: "Open to anyone",
  offered: "Offered",
  working: "Being worked on",
  submitted: "Work handed in",
  accepted: "Accepted",
  "given-up": "Given up",
  cancelled: "Stopped",
};

export const TASK_PROBLEM = {
  post: "The task was not posted. Check your connection and try again.",
  take: "The task was not taken. Someone may have taken it first, or you may have given it up before.",
  handIn: "Your work was not handed in. Check your connection and try again.",
  accept:
    "The work was not marked accepted. Check your connection and try again.",
  /** The payment landed but its record did not: the next press writes the record only. */
  recordAfterPay:
    "The money was sent, but the record that the work was accepted was not saved. Press again to save it: nothing is paid twice.",
  noPayee:
    "The person who took this named no wallet to be paid at, so nothing can be sent. If you accept it now, nothing is paid and this app has no way to pay it later.",
  noPayeeSure:
    "Press again to accept it without paying. It will be closed, unpaid.",
  /** Sent money cannot be taken back, so the app looks again first and stops when the task has moved. */
  changed:
    "This task changed while you were looking, so nothing was paid. Look at it again.",
  ownWork:
    "This work was done by you or by an agent you run. Someone else on the team has to accept it.",
  pairNeedsBoth:
    "This project is run by two people, and a payment from the allowance needs both of you to sign it. That step is not in this app yet. Pay it together from your wallets, then accept the work here without paying.",
  notRunner:
    "Only the wallet that runs this project can pay for a task. Switch your wallet to it.",
  agentLimits:
    "The limits were not set. Only the wallet that runs this project can set them.",
} as const;

/** "40 dollars", "1 dollar". */
export function dollarsWords(usd: number): string {
  return `${usd.toLocaleString("en-US")} ${usd === 1 ? "dollar" : "dollars"}`;
}

/** What a typed dollar amount is wrong about, or null: whole dollars from 1 to 100,000. */
export function dollarsProblem(typed: string): string | null {
  const value = typed.trim().replace(/,/g, "");
  if (!value) return "Say what it pays, in whole dollars.";
  if (!/^[0-9]+$/.test(value)) return "Whole dollars only, like 40.";
  const usd = Number(value);
  if (usd < 1) return "A task pays at least 1 dollar.";
  if (usd > 100_000) return "A task pays at most 100,000 dollars.";
  return null;
}

/**
 * The allowance box holds less than a task pays: how much is in it and when more arrives (the box fills a little every
 * day, a share of the project's money).
 */
export function boxShortWords(box: bigint, perDay: bigint): string {
  const day =
    perDay > 0n
      ? ` About ${dollarsText(perDay)} dollars more goes into it each day.`
      : " Nothing is going into it now, because the allowance is switched off or the project has no money.";
  return `The allowance box holds ${dollarsText(box)} dollars now, which is less than this task pays.${day} Accept the work when the box holds enough.`;
}

/** What a person reads when paying for a task stops. */
export function payProblem(error: unknown): string {
  const words = potProblem(error, "draw");
  return words.startsWith("The draw did not go through")
    ? "The payment did not go through. Nothing was paid. Try again."
    : words;
}

/** What a person reads when setting an agent's limits stops. */
export function limitsProblem(error: unknown): string {
  const words = potProblem(error, "agent");
  return words.startsWith("Changing the helper did not go through")
    ? TASK_PROBLEM.agentLimits
    : words;
}
