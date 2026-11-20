/**
 * The sentences of the team's side of a plan (`docs/next-version/STEP2-SERVER-APP-PLAN.md`, sections 5.1, 5.2 and 5.11): the
 * Plan sheet, why it cannot be pressed, and the lines about the team checking in so that a plan can be taken. Pure. Each
 * says what is so and what to do next, names no event, code or contract, and the sheet carries the play-money line and the
 * legal line itself. The words of every contract refusal live in `money/pot-copy.ts`.
 */
import { timeText } from "../../../money/numbers";
import { NEW_TASK_ERRORS } from "../../../money/pot-copy-tasks";
import { durationWords, noticeWords } from "../duration";
import type { Tie } from "../state";
import { dollarsPhrase, percentOfBps, quotedWhat, tieReason } from "../words";

// --- The sheet's own lines -----------------------------------------------------------------------------------------

/** The sheet's heading. */
export function planTitle(what: string): string {
  return `Plan the pay for ${quotedWhat(what)}`;
}

/** "at most 1.1% of the project's money; if people take out first, less is set aside". */
export function shareLine(shareBps: number): string {
  return `at most ${percentOfBps(shareBps)} of the project's money; if people take out first, less is set aside`;
}

/** "Holders get 14 days notice. It can be taken from 3 Dec, 14:05." */
export function noticeLine(noticeSecs: number, from: number): string {
  return `Holders get ${noticeWords(noticeSecs)} notice. It can be taken from ${timeText(from)}.`;
}

/** What happens when nobody takes it. */
export function lapseLine(takeWindowSecs: number): string {
  return `If nobody takes it within ${durationWords(takeWindowSecs)}, it lapses and nothing moves.`;
}

/** How long the worker has once it is taken. */
export function dueLine(dueSecs: number): string {
  return `Once taken, it is due ${durationWords(dueSecs)} later.`;
}

/**
 * What the team must do so the plan can be taken at all: a plan can be taken only while the team's last check-in still
 * counts. Null when the check-in already covers the whole time it can be taken.
 */
export function checkInLine(input: {
  /** The second the last check-in stops counting. */
  activeEnd: number;
  /** The first second it can be taken, and the end of the time it can be taken. */
  from: number;
  until: number;
}): string | null {
  if (input.activeEnd >= input.until) return null;
  return input.activeEnd <= input.from
    ? `The last check-in counts until ${timeText(input.activeEnd)}. The team must check in again before then, or this cannot be taken at all.`
    : `The last check-in counts until ${timeText(input.activeEnd)}. The team must check in again before then, or this cannot be taken after that.`;
}

/**
 * The folded Details: the share asked (a tenth more than the pay's own share, so a small fall in the project's money does not
 * short-change the worker), the room left under the limit on tasks, what this one needs, and when room comes back.
 */
export function detailsLine(input: {
  shareBps: number;
  roomBps: number;
  /** What the pay is of the project's money, in ten-thousandths, rounded up. */
  needBps: number;
  /** When room next comes back, when there is not enough now. */
  roomBackAt: number | null;
}): string {
  const wait =
    input.roomBps < input.needBps && input.roomBackAt !== null
      ? ` (from ${timeText(input.roomBackAt)})`
      : "";
  return `The share asked is ${percentOfBps(input.shareBps)}, a tenth more than the pay's share of the project's money, so a small fall does not short-change the worker. Room under the limit for tasks now: ${percentOfBps(input.roomBps)} of the project's money. This one needs about ${percentOfBps(input.needBps)} when it is taken; if there is not enough room then, it waits until earlier tasks are old enough to stop counting${wait}.`;
}

/** After the plan landed: the chain's own date for when it can be taken. */
export function plannedWords(from: number): string {
  return `Planned. Holders can see it now, and anyone can take their money out before ${timeText(from)}.`;
}

/** The note when the plan landed (the date follows once it is read from the network). */
export const PLANNED = "Planned.";

/** The note when the plan was asked of the other signer. */
export const PLAN_ASKED =
  "Asked. It is planned when the other signer confirms.";

/** The press's words. */
export const PLAN_PRESS = "Plan this task";
export const PLAN_PRESS_PAIR = "Ask the other signer";
export const PLAN_LOOK = "Look for your plan";

// --- What stops the press (the sheet says which, and nothing is sent) ------------------------------------------------

/** Where a plan cannot be pressed, one sentence each. */
export const PLAN_BLOCK = {
  wound: "This project has wound down, so nothing can be planned any more.",
  stale:
    "We could not refresh this project's numbers, so a plan cannot be sized now. Try again in a moment.",
  quiet:
    "The team has not checked in lately, so no task can be planned or taken until they do. Check in first, on This week.",
  full: NEW_TASK_ERRORS.TooManyOpen.any.replace(" Nothing changed.", ""),
  notRunner:
    "Only the wallet that runs this project can plan a task (with two people running it, either signer can ask the other). Switch your wallet to it.",
  noPay:
    "This task says no pay, so it cannot be planned. Post it again with what it pays.",
  boxPaid:
    "The money for this task was already sent from the box, and only its record is missing. Save that it was paid on the task first. Nothing is planned.",
  /** The same plan is already waiting for the other signer (read from the chain): a second ask would plan the task twice. */
  alreadyAsked:
    "This same plan is already waiting for the other signer to confirm it, so nothing new was asked. They confirm it on the Money tab.",
  tooBig: NEW_TASK_ERRORS.ShareTooBig.any.replace(" Nothing changed.", ""),
} as const;

/** The worker named no wallet to be paid at. */
function noWallet(name: string): string {
  return `${name} has not named a wallet to be paid at, so this cannot be planned. Ask them to agree to the task first.`;
}

/** The same task is already on the network. */
export function alreadyPlanned(from: number): string {
  return `This task is already planned: it can be taken from ${timeText(from)}.`;
}

/** The task record cannot be planned because of how it stands here. */
export function cannotPlan(
  why: Extract<Tie, { ok: false }>["why"],
  name: string,
) {
  switch (why) {
    case "payee":
      return noWallet(name);
    case "amount":
      return PLAN_BLOCK.noPay;
    case "closed":
      return "This task was stopped or given up here, so it cannot be planned.";
    case "already-paid":
      return "This task was already paid here, so it cannot be planned.";
    case "worker-left":
      return `${name} gave this task up, so it cannot be planned.`;
    case "not-taken":
      return "Nobody has taken or agreed to this task yet, so it cannot be planned. Ask someone to take it first.";
    default:
      return "This task cannot be planned as it stands here.";
  }
}

/** The numbers the sheet showed moved before the press. */
export const PLAN_MOVED =
  "The notice for this plan moved while you were looking. Nothing was sent. Close this and open it again.";

/** What the sheet says when what it needs could not be read. */
export const PLAN_READ_FAILED =
  "What a plan needs could not be read from the network, so nothing can be sent now. Nothing was planned.";

// --- On the card ---------------------------------------------------------------------------------------------------------

/** The line on the card before a plan: a worker has the task but named no wallet. */
export function waitingForWallet(name: string): string {
  return `${name} has not named a wallet to be paid at, so the team cannot plan the pay yet. Ask them to agree to the task first.`;
}

/** The price of the plan in a button: "Plan the pay of 40 dollars". */
export function planButton(usd: bigint): string {
  return `Plan the pay of ${dollarsPhrase(usd)}`;
}

/** The second way in, shown beside the box door. */
export const PLAN_INSTEAD = "Plan it instead, so holders get notice first.";

/**
 * On a card, to everyone: a planned task can only be taken while the team's check-in counts. Said when it cannot be taken at the
 * moment it first could be.
 */
export function notTakeable(activeUntil: number): string {
  return `This task cannot be taken unless the team checks in before ${timeText(activeUntil)}.`;
}

/** On the Tasks tab, to the team: planned tasks that nobody can take unless the project checks in again. */
export function teamCheckIn(input: {
  count: number;
  from: number;
  activeUntil: number;
}): string {
  const many = input.count !== 1;
  return `${many ? `${input.count} planned tasks` : "1 planned task"} can be taken from ${timeText(input.from)}, but nobody can take ${many ? "them" : "it"} unless the project checks in again before ${timeText(input.activeUntil)}. Check in on This week.`;
}

/** On a card: the network's plan is shown with the network's numbers, but it is not for this task as it is written here. */
export function planNotTied(why: Extract<Tie, { ok: false }>["why"]): string {
  return `The plan on the network is not for this task as it is written here (${tieReason(why)}). The numbers above are the network's.`;
}

/** On the card of a second plan of a task that is already planned. */
export function secondPlan(first: bigint): string {
  return `This is a second plan for a task that is already planned (task ${first} came first), so only the first can be paid.`;
}
