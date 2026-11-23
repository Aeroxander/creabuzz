/**
 * The words of the Tasks tab: what each state says, and every problem a task step can meet as a sentence that says
 * what happened and what to do next. Money problems come from `moneyProblem`; this adds the steps that are records.
 */
import { countWord } from "../council/vote-words";
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
    "The person who took this named no account to be paid at, so nothing can be sent. If you accept it now, nothing is paid and this app has no way to pay it later.",
  noPayeeSure:
    "Press again to accept it. It will show as accepted, pay owed, and nothing can be sent from here.",
  pairSure:
    'Press again to accept it now. It will show as accepted, pay owed. Then press "Ask for the pay from the box" on the task: the other signer confirms it, and the payment is linked to this task.',
  boxShortSure:
    'Press again to accept it now. It will show as accepted, pay owed, and the task offers "Pay from the box" as soon as the box holds enough.',
  /** On an accepted task whose worker named no wallet. */
  owedNoPayee:
    "The person who did this named no account to be paid at, so the pay cannot be sent from here.",
  /** After a Pair's signer asked for the pay: nothing moved yet. */
  asked:
    "Asked. The pay goes out when the other signer confirms it on the Money tab. Then come back here and save that it was paid.",
  /** A payment of exactly this task's pay already left the box: nothing is sent until the person says what it was. */
  alreadyLeft:
    "A payment of exactly this much already left the box for this person. Nothing was sent. If it was this task's pay, save it here; if it was for something else, say so and press again.",
  /** The same pay is already asked of the other signer (read from the chain): a second ask would pay it twice. */
  alreadyAsked:
    "This same pay is already waiting for the other signer to confirm it, so nothing new was asked. They confirm it on the Money tab; then come back here and save that it was paid.",
  /** What is waiting for the other signer could not be read: nothing is asked on a guess. */
  askedUnknown:
    "What is already waiting for the other signer could not be read just now, so nothing was asked. Press again in a moment.",
  /** The search for an earlier payment could not be read or did not reach far enough back: nothing is sent on a guess. */
  searchShort:
    "Whether this pay was already sent could not be checked just now (the network did not answer). Nothing was sent. Look again in a moment, or check the project's money records first.",
  /** The search went back as far as it goes without reaching the day of the acceptance: a person may say nothing was paid. */
  searchTooOld:
    "This work was accepted so long ago that the search could not reach back to that day, and it found no payment. If you know this pay was never sent, say so here and pay it from the box. Otherwise check the project's money records first.",
  /** A project wound down draws nothing. */
  woundDown:
    "This project is wound down, so nothing can be drawn from the allowance box any more.",
  /** A plan of this task stands on the network: it is paid there, never from the box (one door). */
  plannedOnNetwork:
    "This task is planned on the network, so it is paid there. Nothing was sent from the box. Look at the task again.",
  /** The network could not say whether a plan of this task stands: nothing is paid on a guess. */
  planUnknown:
    "Whether this task is planned on the network could not be checked just now, so nothing was sent. Try again in a moment.",
  /** Sent money cannot be taken back, so the app looks again first and stops when the task has moved. */
  changed:
    "This task changed while you were looking, so nothing was paid. Look at it again.",
  ownWork:
    "This work was done by you or by an agent you run. Someone else on the team has to accept it.",
  pairNeedsBoth:
    'This project is run by two people, and a payment from the allowance needs both of you to sign it. Ask for the payment with "Draw from the box" on the Money tab: the other signer confirms it there.',
  notRunner: "Only the account that runs this project can pay for a task.",
  agentLimits:
    "The limits were not set. Only the account that runs this project can set them.",
} as const;

/** Who must say yes to a runner's press before it happens: a Pair's other signer, or a Council's other seats. */
export type AgreedBy = "pair" | "council";

/**
 * The three sentences of the pay-from-the-box press after it asks the runner's others first. The Pair's words are
 * `TASK_PROBLEM`'s `asked`, `alreadyAsked` and `askedUnknown`; a Council's name the record's own threshold, never a
 * typed number. Same sentences, same order, whatever kind of runner asked.
 */
export function payAskedWords(
  by: AgreedBy,
  needed: number,
  seats: number,
): string {
  return by === "pair"
    ? TASK_PROBLEM.asked
    : `Asked. The pay goes out when ${needed} of the ${countWord(seats)} seats agree to it on the Money tab. Then come back here and save that it was paid.`;
}

/** The same pay is already waiting out there: a second ask would pay it twice. */
export function payAlreadyAskedWords(
  by: AgreedBy,
  needed: number,
  seats: number,
): string {
  return by === "pair"
    ? TASK_PROBLEM.alreadyAsked
    : `This same pay is already waiting for ${needed} of the ${countWord(seats)} seats to agree to it, so nothing new was asked. They agree on the Money tab; then come back here and save that it was paid.`;
}

/** What is waiting could not be read: nothing is asked on a guess. */
export function payAskedUnknownWords(by: AgreedBy): string {
  return by === "pair"
    ? TASK_PROBLEM.askedUnknown
    : "What is already waiting for the seats could not be read just now, so nothing was asked. Press again in a moment.";
}

/**
 * Why "accept and pay" cannot pay here when a Council runs the project: enough seats must agree to the draw, which is
 * not one press, so the work is accepted first and the pay is asked for after (the Pair's words are
 * `TASK_PROBLEM.pairNeedsBoth`). The numbers are the record's own.
 */
export function councilNeedsAgreementWords(
  needed: number,
  seats: number,
): string {
  return `This project is run by ${countWord(seats)} accounts, and a payment from the allowance needs ${needed} of them to agree. Ask for the payment with "Draw from the box" on the Money tab: the seats agree to it there.`;
}

/** The accept-now words for the same case (the Pair's are `TASK_PROBLEM.pairSure`). */
export function councilSureWords(needed: number, seats: number): string {
  return `Press again to accept it now. It will show as accepted, pay owed. Then press "Ask for the pay from the box" on the task: when ${needed} of the ${countWord(seats)} seats agree, the payment goes out and is linked to this task.`;
}

/**
 * What the server says when a step on a task that has a plan on the network is refused, in the words a person reads. The server's
 * own sentences carry a prefix for programs (`invalid:`, `restricted:`) that is not shown. `retry:` is not mapped: a caller reads
 * it to try again. Null for any other message.
 */
/** A refusal by the server that has been put in plain words: its message is what a person reads. */
export class TaskRefusal extends Error {}

/**
 * What a person reads when the record of a payment could not be saved: the server's refusal in plain words, the "not read it
 * yet" sentence for a `retry:`, and otherwise the generic one. A payment the network does not show, or shows paying another
 * account or another amount, never leaves a task marked paid.
 */
export function recordProblem(error: unknown, retryWords: string): string {
  if (error instanceof TaskRefusal) return error.message;
  if (error instanceof Error && error.message.startsWith("retry:"))
    return retryWords;
  return TASK_PROBLEM.recordAfterPay;
}

export function taskRefusalWords(message: string): string | null {
  const said = message.toLowerCase();
  const table: readonly (readonly [string, string])[] = [
    [
      "name the account you will take it with",
      "This task is planned on the network, so it is paid to an account you name. Connect your account and take it again.",
    ],
    [
      "the plan on the network names another account",
      "The team planned this task for another account, so it cannot be taken with this one.",
    ],
    [
      "already taken on the network by another account",
      "Someone else has already taken this task.",
    ],
    [
      "plan has ended on the network",
      "This task's plan has ended, so it cannot be taken any more.",
    ],
    [
      "pay it on the network first",
      "The payment is not on the network yet. Pay it there first, then save that it was paid.",
    ],
    [
      "not the payment that paid this task",
      "That is not the payment that paid this task.",
    ],
    [
      "paid another account than the one the worker named",
      "The network paid another account than the one the worker named, so this cannot be saved as paid.",
    ],
    // The checks of a task paid out of the allowance box (the network must show the payment, to that worker, for that pay).
    [
      "the network does not show that payment",
      "The network does not show that payment. Nothing is saved as paid. Check the payment's transaction and try again.",
    ],
    [
      "has not named a wallet to be paid at",
      "The worker has not named an account to be paid at, so nothing can be saved as paid.",
    ],
    [
      "the payment went to another wallet than the one the worker named",
      "The payment went to another account than the one the worker named, so it is not saved as this task's pay.",
    ],
    [
      "the payment is not what the task pays",
      "The payment is not the amount this task pays, so it is not saved as this task's pay.",
    ],
    [
      "that payment already paid another task",
      "That payment already paid another task, so it is not saved for this one.",
    ],
    [
      "write the payment's transaction in lower case",
      "The payment's transaction could not be read the way the server needs it. Nothing is saved. Try again.",
    ],
    [
      "withdraw or send back the money on the network first",
      "The money for this task is still set aside on the network. Withdraw the plan or send the money back first.",
    ],
  ];
  return table.find(([tail]) => said.includes(tail))?.[1] ?? null;
}

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

/** What every reader of an accepted task with money on sees while its pay has not been recorded: never "paid". */
export function owedWords(usd: number): string {
  return `Accepted, pay owed: ${dollarsWords(usd)}.`;
}

/** What every reader sees once the payment's transaction is on the task's record. */
export function paidWords(usd: number): string {
  return `Paid ${dollarsWords(usd)}.`;
}

/**
 * A paid task whose payment this page cannot read as an amount (the network's row for it left the list, and a part payment is
 * only held there): it never reads as paid in full, only as paid, with the price it was posted at.
 */
export function paidPriceWords(usd: number): string {
  return `Paid. The price was ${dollarsWords(usd)}.`;
}

/**
 * The allowance box holds less than a task pays: how much is in it and when more arrives (the box fills a little every
 * day, a share of the project's money). `then` is what a person can do about it.
 */
export function boxShortWords(
  box: bigint,
  perDay: bigint,
  then = "You can accept the work now and pay it from the box once it holds enough.",
): string {
  const day =
    perDay > 0n
      ? ` About ${dollarsText(perDay)} dollars more goes into it each day.`
      : " Nothing is going into it now, because the allowance is switched off or the project has no money.";
  return `The allowance box holds ${dollarsText(box)} dollars now, which is less than this task pays.${day} ${then}`;
}

/** The sentence beside "Pay from the box": what goes where. */
export function payTermsWords(usd: number, payee: string): string {
  return `${dollarsWords(usd)} go from the allowance box to ${payee}, the account the worker named.`;
}

/** The payment found on the chain, in words. */
export function foundWords(
  usd: number,
  payee: string,
  at: number | null,
): string {
  const when =
    at === null
      ? ""
      : ` on ${new Date(at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  return `A payment of ${dollarsWords(usd)} to ${payee} left the box${when}. If it was this task's pay, save it here: nothing is paid twice.`;
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

/**
 * The accessible name of a press on one task of a list: the press's own words, then which task. Two cards' presses with the
 * same words would otherwise be told apart by nothing a screen reader says. The visible words come first, so the name always
 * contains what is on the button.
 */
export function pressName(
  label: string,
  what: string | null | undefined,
): string {
  const words = (what ?? "").replace(/\s+/g, " ").trim();
  if (!words) return label;
  return `${label}: ${words.length > 60 ? `${words.slice(0, 59)}…` : words}`;
}
