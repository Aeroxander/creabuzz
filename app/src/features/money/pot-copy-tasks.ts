/**
 * The sentences for every refusal of the task book and of the Treasury's task calls (`docs/next-version/
 * STEP2-SERVER-APP-PLAN.md`, section 4.6): each says what happened and what to do next, and shows no name, code or hex.
 * `pot-copy.ts` keys its table by every error name of every contract, so it does not compile until each has words; the
 * errors that are new with the task book are all here, and so are the sentences the older errors say for the task actions.
 *
 * A leaf module: it imports only the number words, so `pot-copy.ts` and the task screens' words both build on it.
 */
import type { DecodedValue } from "@creaton/core/launchpad/evmAbi.ts";
import { smallDollarsText } from "../pot/pot-words";
import { timeText } from "./numbers";

/** What a person was doing when a task step stopped; some refusals read better said for one of them. */
export type TaskAction =
  | "plan-task"
  | "take-task"
  | "pay-task"
  | "send-back-task"
  | "withdraw-task"
  | "return-task"
  | "claim-note";

/** One sentence, or one made from the refusal's arguments. */
export type Text = string | ((args: readonly DecodedValue[]) => string);

const num = (v: DecodedValue | undefined): bigint =>
  typeof v === "bigint" ? v : 0n;

/** "1 dollar", "25 dollars", "2.50 dollars", "0.43 dollars": an amount of dollar units in a sentence. */
export function dollarsPhrase(raw: bigint): string {
  // The text is rounded down, so an amount a hair over one dollar reads "1 dollar", never "1 dollars".
  const text = smallDollarsText(raw);
  return text === "1" ? "1 dollar" : `${text} dollars`;
}

/** A share in ten-thousandths of the project's money as a percent: 100 is "1%", 495 is "4.95%", 1 is "0.01%". */
export function percentOfBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const hundredths = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return hundredths === "" ? `${whole}%` : `${whole}.${hundredths}%`;
}

const NOTHING_CHANGED = "Nothing changed.";
const bps = (v: DecodedValue | undefined) => percentOfBps(Number(num(v)));

/** The errors that are new with the task book: each has a sentence for any action. */
export const NEW_TASK_ERRORS = {
  ShareTooBig: {
    any: "That is more of the project's money than one task may ask for. Plan it in smaller parts. Nothing changed.",
  },
  TooManyOpen: {
    any: "The most tasks are already planned or taken. Wait for one to end, or withdraw one that nobody has taken. Nothing changed.",
  },
  NoSuchTask: {
    any: "The network does not know that task. Nothing changed.",
  },
  WrongTaskState: {
    "take-task":
      "This task cannot be taken now: it was already taken, withdrawn or has ended. Nothing changed.",
    "pay-task":
      "This task is not waiting for a payment: it may already be paid, sent back or have run out. Nothing was paid.",
    "send-back-task":
      "This task is not waiting for a payment: it may already be paid, sent back or have run out. Nothing was paid.",
    "withdraw-task":
      "Someone has taken this task, or its time is over, so it cannot be withdrawn. Nothing changed.",
    any: `This task is not in a state this step works on. ${NOTHING_CHANGED}`,
  },
  NoticeRunning: {
    any: (a) =>
      `The notice is still running. This task can be taken from ${timeText(Number(num(a[0])))}. ${NOTHING_CHANGED}`,
  },
  TakeWindowOver: {
    any: "The time to take this task is over, so it lapses and nothing was set aside. Ask the team to plan it again.",
  },
  CapReached: {
    any: (a) =>
      `Too much of the project's money has been set aside for tasks recently: ${bps(a[0])} of the ${bps(a[2])} the limit allows, and this task needs ${bps(a[1])}. It can be taken once earlier tasks are old enough to stop counting. Nothing was set aside.`,
  },
  TakesFull: {
    any: "The limit on tasks taken recently has been reached, so this one cannot be taken yet. Try again later. Nothing was set aside.",
  },
} as const satisfies Record<
  string,
  { any: Text } & Partial<Record<TaskAction, Text>>
>;

/**
 * What an error that was already worded says when the action is a task step: merged over the existing entry, which keeps
 * its own sentences for every other action (and `any`).
 */
export const TASK_EXTENSIONS = {
  BadInput: {
    "plan-task":
      "A task needs its record, a person to pay who is not the project itself, at least 1 dollar and a share of the project's money from 0.01% to 5%. Nothing changed.",
    "pay-task":
      "Pay more than nothing, or send the money back instead. Nothing was paid.",
  },
  TooLittleCash: {
    "take-task": (a) =>
      `The project's money moved, so only ${dollarsPhrase(num(a[1]))} would be set aside, less than the ${dollarsPhrase(num(a[0]))} you asked for. Nothing was taken. Look again and press again.`,
  },
  TooMuch: {
    "pay-task": (a) =>
      `That is more than the ${dollarsPhrase(num(a[1]))} set aside for this task. Pay less. Nothing was paid.`,
  },
  NotYet: {
    "return-task": (a) =>
      `This task is not past its deadline yet. The money can be returned from ${timeText(Number(num(a[0])))}. ${NOTHING_CHANGED}`,
    "claim-note": (a) =>
      `This task has not ended yet, so there is nothing to claim. It ends by ${timeText(Number(num(a[0])))}.`,
  },
  NothingToPay: {
    "claim-note": `There is nothing to claim here: the task was paid in full, or you already claimed. ${NOTHING_CHANGED}`,
  },
  NotAllowed: {
    "plan-task":
      "Only the person who runs the project can plan a task (with two people running it, both must say yes), and a task cannot be paid to someone who runs the project. Nothing changed.",
    "send-back-task":
      "Only the person who runs the project can do this (with two people running it, both must say yes). Nothing changed.",
    "withdraw-task":
      "Only the person who runs the project can do this (with two people running it, both must say yes). Nothing changed.",
    "pay-task":
      "Only the person who runs the project can pay for a task, and not someone who took the task and now also runs the project. Nothing was paid.",
    "take-task":
      "This task is for someone else, or you run this project and so cannot take its tasks. Nothing changed.",
  },
} as const satisfies Record<string, Partial<Record<TaskAction, Text>>>;

/** What each task step is called in the line a failure falls back to ("{words} did not go through. Nothing changed. Try again."). */
export const TASK_ACTION_WORDS: Record<TaskAction, string> = {
  "plan-task": "Planning the task",
  "take-task": "Setting the money aside",
  "pay-task": "The payment",
  "send-back-task": "Sending the money back",
  "withdraw-task": "Withdrawing the plan",
  "return-task": "Returning the money",
  "claim-note": "The claim",
};
