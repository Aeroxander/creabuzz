/**
 * The sentences of the team's sheets that act on a task already on the network (`docs/next-version/STEP2-SERVER-APP-PLAN.md`,
 * sections 5.5, 5.6 and 5.7): pay in full or in part, send the money back, withdraw a plan, and save that a task was paid. Pure.
 * Each says what is so and what to do next, names no event, code or contract; the sheets carry the play-money line and the
 * legal line themselves. The words of every contract refusal live in `money/pot-copy.ts`.
 */
import { timeText } from "../../../money/numbers";
import { exactDollarsText } from "../../../pot/pot-words";
import { quotedWhat } from "../words";

/**
 * "57.486851 dollars", "1 dollar": an amount the press will move, exactly as it is (the sheets of this file never round a
 * figure down: what is shown is what is paid).
 */
export function exactPhrase(raw: bigint): string {
  return raw === 1_000_000n ? "1 dollar" : `${exactDollarsText(raw)} dollars`;
}

// --- Pay in full or in part (5.5) -------------------------------------------------------------------------------------

export function payTitle(what: string): string {
  return `Pay for the work on ${quotedWhat(what)}`;
}

/** The button on the card that opens the sheet. */
export const PAY_OPEN = "Pay for the work";
export const PAY_PRESS_PAIR = "Ask the other signer";
export const PAY_LOOK = "Look for your payment";
export const PAY_CHOICE = "How much to pay";
export const PAY_FIXED_LEFT =
  "What is left goes back to the project and to the people who took out while it was set aside.";

export function payAll(setAside: bigint): string {
  return `Pay all ${exactPhrase(setAside)}`;
}

export const PAY_PART = "Pay part";
export const PAY_PART_LABEL = "Amount to pay, in dollars";

/** What a press says: "Pay 60 dollars". */
export function payPress(pay: bigint): string {
  return `Pay ${exactPhrase(pay)}`;
}

/** The line that says what goes back; nothing when all of it is paid. */
export function goesBack(rest: bigint): string {
  if (rest === 0n) return "Nothing goes back: all of it is paid.";
  return `${exactPhrase(rest)} ${rest === 1_000_000n ? "goes" : "go"} back.`;
}

/** What is set aside and when it is due. */
export function setAsideLine(setAside: bigint, deadline: number): string {
  return `${exactPhrase(setAside)}, due ${timeText(deadline)}`;
}

export function paidDone(pay: bigint, name: string): string {
  return `Paid ${exactPhrase(pay)} to ${name}.`;
}

export const PAY_ASKED = "Asked. It is paid when the other signer confirms.";

export const PAY_READ_FAILED =
  "What a payment needs could not be read from the network, so nothing can be sent now. Nothing was paid.";

/** The task's money, in the Details fold: where the pay goes and that it cannot go anywhere else. */
export const PAY_DETAILS =
  "The money goes to the account that took the task on the network, and to no other. Whatever you do not pay goes back to the project and to the people who took out while it was set aside.";

/** After the payment landed: the team's record could not be written (the next press writes the record only). */
export const PAID_NOT_YET =
  "The network does not show this task as paid yet. Try again in a moment.";
export const PAID_NOT_FOUND =
  "The payment could not be found on the network just now, so the record was not saved. Nothing is paid twice: try again in a moment.";
export const PAID_SAVED = "Saved that it was paid.";
export const PAID_RETRY =
  "The payment went through. The server has not read it yet, so the record is not saved. Press again in a few minutes: nothing is paid twice.";

/** The card's press when the money was paid on the network and the team's record does not say so yet. */
export const SAVE_PAID = "Save that it was paid";
export const SAVE_PAID_WORDS =
  "This task was paid on the network, but the record on the team's list does not say so yet.";

// --- Send the money back (5.6) --------------------------------------------------------------------------------------

export const SEND_BACK_OPEN = "Send the money back";
export const SEND_BACK_PRESS = "Send the money back";
export const SEND_BACK_LOOK = "Look for your step";
export const SEND_BACK_DONE = "Sent back. The money is in the project again.";
export const SEND_BACK_ASKED =
  "Asked. It is sent back when the other signer confirms.";

export function sendBackTitle(what: string | null): string {
  return `Send the money back for ${quotedWhat(what)}`;
}

/** The sheet's one paragraph. */
export function sendBackWords(setAside: bigint): string {
  return `Nobody is paid. All ${exactPhrase(setAside)} go back to the project and to the people who took out while it was set aside.`;
}

export const SEND_BACK_DETAILS =
  "This does not use up the room the project has for tasks.";

/** The deadline passed: the task ends by itself and nothing can be sent back. */
export const SEND_BACK_LATE =
  "The deadline has passed, so this task ends by itself and the money goes back to the project. Nothing needs sending back.";

// --- Withdraw a plan (5.7) --------------------------------------------------------------------------------------------

export const WITHDRAW_OPEN = "Withdraw the plan";
export const WITHDRAW_PRESS = "Withdraw the plan";
export const WITHDRAW_LOOK = "Look for your step";
export const WITHDRAW_DONE = "Withdrawn.";
export const WITHDRAW_ASKED =
  "Asked. It is withdrawn when the other signer confirms.";

export function withdrawTitle(what: string | null): string {
  return `Withdraw the plan for ${quotedWhat(what)}`;
}

export const WITHDRAW_WORDS =
  "Nobody has taken it, so no money moves. The task stays on your list and can be planned again.";

/** Someone took it: the money is set aside, so the plan cannot be withdrawn. */
export const WITHDRAW_TAKEN =
  "Someone has taken this task. Send the money back instead.";

/** The plan is not waiting to be taken any more: it was taken, withdrawn or ended since the sheet was drawn. */
export function withdrawEnded(phase: string): string {
  return `This plan is no longer waiting to be taken: it is ${phase}. Nothing changed.`;
}

/** The plan's time is up: it lapses by itself. */
export const WITHDRAW_LATE =
  "The time for this plan is over, so it lapses by itself and nothing moves.";

// --- After a withdrawal: stop the task here as well --------------------------------------------------------------------

export const STOP_OPEN = "Stop this task";
export const STOP_WORDS =
  "The plan was withdrawn on the network. You can stop the task on your list too, so nobody takes it up again.";
export const STOP_NOTE = "The plan for this task was withdrawn.";
export const STOP_DONE = "The task is stopped.";
