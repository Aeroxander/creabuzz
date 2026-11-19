/**
 * The words of the Tasks tab: what each state says, and every problem a task step can meet as a sentence that says
 * what happened and what to do next. Money problems come from `moneyProblem`; this adds the steps that are records.
 */
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import { moneyProblem } from "../money/money-copy";
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
  pairAboveAlone:
    "Above 500 dollars at Team both signers must agree, and the second signer's step is not in this app yet. Pay it from your wallet together, then accept it here.",
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

/** The Treasury's refusal when the project has less to spend than asked (`TooMuch(amount, available)`). */
const TOO_MUCH = selectorOf("TooMuch(uint256,uint256)").slice(2).toLowerCase();

function mentions(error: unknown, needle: string, depth = 0): boolean {
  if (depth > 4 || error === null || error === undefined) return false;
  if (typeof error === "string") return error.toLowerCase().includes(needle);
  if (typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  return ["message", "data", "error", "cause", "reason"].some((field) =>
    mentions(e[field], needle, depth + 1),
  );
}

/** What a person reads when paying for a task stops. */
export function payProblem(error: unknown): string {
  if (mentions(error, TOO_MUCH) || mentions(error, "toomuch"))
    return "The project has less money to spend than this task pays, so nothing was paid.";
  const words = moneyProblem(error, "connect");
  return words.startsWith("Connecting your wallet")
    ? "The payment did not go through. Nothing was paid. Try again."
    : words;
}

/** What a person reads when setting an agent's limits stops. */
export function limitsProblem(error: unknown): string {
  const words = moneyProblem(error, "connect");
  return words.startsWith("Connecting your wallet")
    ? TASK_PROBLEM.agentLimits
    : words;
}
