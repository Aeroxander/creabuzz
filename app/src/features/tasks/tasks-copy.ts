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
    "Press again to accept it. It will show as accepted, pay owed, and nothing can be sent from here.",
  pairSure:
    'Press again to accept it now. It will show as accepted, pay owed. Then press "Ask for the pay from the box" on the task: the other signer confirms it, and the payment is linked to this task.',
  boxShortSure:
    'Press again to accept it now. It will show as accepted, pay owed, and the task offers "Pay from the box" as soon as the box holds enough.',
  /** On an accepted task whose worker named no wallet. */
  owedNoPayee:
    "The person who did this named no wallet to be paid at, so the pay cannot be sent from here.",
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

/**
 * What the server says when a step on a task that has a plan on the network is refused, in the words a person reads. The server's
 * own sentences carry a prefix for programs (`invalid:`, `restricted:`) that is not shown. `retry:` is not mapped: a caller reads
 * it to try again. Null for any other message.
 */
export function taskRefusalWords(message: string): string | null {
  const said = message.toLowerCase();
  const table: readonly (readonly [string, string])[] = [
    [
      "name the wallet you will take it with",
      "This task is planned on the network, so it is paid to a wallet you name. Connect a wallet and take it again.",
    ],
    [
      "the plan on the network names another wallet",
      "The team planned this task for another wallet, so it cannot be taken with this one.",
    ],
    [
      "already taken on the network by another wallet",
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
      "paid another wallet than the one the worker named",
      "The network paid another wallet than the one the worker named, so this cannot be saved as paid.",
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
  return `${dollarsWords(usd)} go from the allowance box to ${payee}, the wallet the worker named.`;
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
