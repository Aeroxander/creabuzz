/**
 * The sentences of the money a person is owed from tasks they took out of while money was set aside (plan section 5.9): the
 * list, one row's two lines, the look back, and the Claim sheet. Pure. "Note" is the contract's word: people read "money you
 * can claim". Each sentence says what is so and what to do next and names no event, code or contract.
 */
import { dayText, timeText } from "../../../money/numbers";
import { TASK_EXTENSIONS } from "../../../money/pot-copy-tasks";
import type { Phase } from "../state";
import { dollarsPhrase, quotedWhat } from "../words";

// --- The list ---------------------------------------------------------------------------------------------------------

export const CLAIMS_HEADING = "Money you can claim";

/** The button under the list that searches the network's own records. */
export const LOOK_FIRST = "Look for money I can claim";

/** Under the heading, always: what is owed never runs out, and where the list comes from. */
export const CLAIMS_NEVER_EXPIRE = `Money you are owed from a task never runs out. This list shows what the server and this browser remember. If one is missing, press “${LOOK_FIRST}” under this list: it searches the network's own records for older ones.`;

/** Nothing is listed; the server's list is whole, or it is cut. */
export const CLAIMS_NONE = "Nothing is waiting for you to claim.";
export const CLAIMS_NONE_CUT = `Nothing is listed for you, but the server's list is cut, so an older one may be missing. Press “${LOOK_FIRST}” to find it.`;

export const CLAIMS_READ_FAILED =
  "What you can claim could not be read from the network just now. Your money is not affected. Try again in a moment.";

/** More rows than the first page of the You page. */
export const SHOW_MORE = "Show more";

/** One row: which task, how much was set aside when the person took out, and whether it is still running. */
export function claimHeadline(input: {
  what: string | null;
  setAside: bigint;
  running: boolean;
}): string {
  return `${quotedWhat(input.what)}: you took out while ${dollarsPhrase(input.setAside)} ${input.setAside === 1_000_000n ? "was" : "were"} set aside for it. The task is ${input.running ? "still running" : "ended"}.`;
}

/** The second line of a row: what the person could be paid, by what the task has done. */
export function claimLine(input: {
  phase: Phase;
  face: bigint;
  claimable: bigint;
  paidInFull: boolean;
}): string {
  if (input.phase === "working")
    return `You will be able to claim up to ${dollarsPhrase(input.face)} if it is not paid.`;
  if (input.phase === "overdue")
    return `This task ran out. You can claim ${dollarsPhrase(input.face)} now; claiming returns the money first.`;
  if (input.paidInFull)
    return "It was paid in full, so there is nothing to claim.";
  return input.claimable > 0n
    ? `You can claim ${dollarsPhrase(input.claimable)} now.`
    : "There is nothing to claim here now.";
}

export function claimPress(claimable: bigint): string {
  return `Claim ${dollarsPhrase(claimable)}`;
}

// --- The look back ------------------------------------------------------------------------------------------------------

export const LOOK_FURTHER = "Look further back";
export const LOOKING = "Looking…";

/** The look ended before the start of the project's tasks: where it got to, and that the next press goes on. */
export function lookedBackTo(at: number | null): string {
  return at === null
    ? "Looked back part of the way. Look further back."
    : `Looked back to ${dayText(at)}. Look further back.`;
}

/** Only a look that reached the start of the project's tasks may say nothing was found. */
export const LOOKED_ALL_NONE =
  "Nothing found back to the start of this project's tasks.";
export const LOOKED_ALL_FOUND =
  "Looked back to the start of this project's tasks.";
export const LOOK_REFUSED = "Could not look just now. Try again in a moment.";

// --- The Claim sheet ------------------------------------------------------------------------------------------------

export function claimTitle(claimable: bigint, what: string | null): string {
  return `Claim ${dollarsPhrase(claimable)} for ${quotedWhat(what)}`;
}

/** The heading before the numbers are read, and when there is nothing to claim. */
export function claimTitleOf(what: string | null): string {
  return `Claim the money you are owed for ${quotedWhat(what)}`;
}

export const CLAIM_LOOK = "Look for your claim";
export const CLAIMED = "Claimed. The money is in your wallet.";

/** What the Claim sheet says about an ended task: what was set aside, what came back, what is owed now. */
export function claimEndedWords(input: {
  setAside: bigint;
  returned: bigint;
  claimable: bigint;
}): string {
  return `When you took out, ${dollarsPhrase(input.setAside)} ${input.setAside === 1_000_000n ? "was" : "were"} set aside for this task. It ended, and ${dollarsPhrase(input.returned)} of it came back; you are owed ${dollarsPhrase(input.claimable)} now.`;
}

/** What the Claim sheet says about a task that ran out and that nobody has returned yet. */
export function claimOverdueWords(input: {
  setAside: bigint;
  face: bigint;
  deadline: number;
}): string {
  return `When you took out, ${dollarsPhrase(input.setAside)} ${input.setAside === 1_000_000n ? "was" : "were"} set aside for this task. It ran out on ${timeText(input.deadline)} and nobody has returned the money yet. Claiming returns it first, and you are owed ${dollarsPhrase(input.face)} now.`;
}

export const CLAIM_TO_YOU = "The money goes to your account.";

export const CLAIM_READ_FAILED =
  "What this claim needs could not be read from the network, so nothing can be sent now. Nothing changed.";

/** Where a claim is stopped, one sentence each (the contract's own words where it has them). */
export const CLAIM_BLOCK = {
  nothing: TASK_EXTENSIONS.NothingToPay["claim-note"],
  inconsistent:
    "Something in the project's numbers did not add up, so nothing was done. Nothing changed. Try again in a moment.",
} as const;

/** The task has not ended yet. */
export function claimNotYet(until: number): string {
  return TASK_EXTENSIONS.NotYet["claim-note"]([BigInt(until)]);
}
