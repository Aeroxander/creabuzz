/**
 * What a task is, from the network's numbers (`docs/next-version/STEP2-SERVER-APP-PLAN.md`, sections 4.4, 5.1, 5.4 and 5.5).
 * Pure functions, no reads: the state a person sees is a function of a row of the signed record and the clock, and a press
 * is gated by a fresh read of the chain (`acceptGate`). A team member's own task record never changes what the app calls a
 * state; it can only fail a tie.
 *
 * The door rule and the share of a plan live in `door.ts`, the lengths of time in `duration.ts` and the sentences more
 * than one screen says in `words.ts`; they are all re-exported here so a screen imports from one place.
 */
import type { WorkerLinks, ProjectTask } from "../task-record";
import { checksOwnWork } from "../task-record";
import type { ProjectNumbers } from "../../money/numbers";
import { isRunner, signsForRunner, timeText } from "../../money/numbers";
import type { ChainTask, ChainTaskNow, ChainTasks } from "./types";
import {
  deadlinePassed,
  dollarsPhrase,
  NOT_RUNNER,
  NOTHING_SET_ASIDE,
  notThisTask,
  notWaitingForPay,
  OWN_WORK,
  plannedMoreThanOnce,
  takerDiffers,
} from "./words";

export { doorFor, shareFor } from "./door";
export { durationWords, noticeWords } from "./duration";

/**
 * Where a task is, by the dates and the network's state (5.4):
 * a plan in its notice, open to be taken, missed (nobody took it in time), taken and working, taken and overdue (ran out,
 * not yet returned), or ended in one of five ways. `wound-down` is an ended row whose `resolvedAt` equals the record's
 * wind-down time: the sweep, not a decision about the task.
 */
export type Phase =
  | "notice" // announced, now < noticeEnd
  | "open" // announced, noticeEnd <= now < expiresAt
  | "missed" // announced, now >= expiresAt (nobody took it in time; it lapses)
  | "working" // taken, now < deadline
  | "overdue" // taken, now >= deadline (ran out, not yet returned)
  | "paid"
  | "sent-back"
  | "ran-out"
  | "withdrawn"
  | "lapsed"
  | "wound-down"; // ended by the project's wind-down sweep

/** Whether a network task ties to the team's task record, and the first reason it does not (in this order). */
export type Tie =
  | { ok: true }
  | {
      ok: false;
      why:
        | "no-record"
        | "what"
        | "closed"
        | "already-paid"
        | "amount"
        | "payee"
        | "taker"
        | "repeat"
        | "worker-left"
        | "not-taken";
    };

/** The one clock every phase and date test uses: a phone set behind cannot make an ended task look open (1.6). */
export function nowOf(
  asOfTime: number,
  device: number = Math.floor(Date.now() / 1000),
): number {
  return Math.max(device, asOfTime);
}

/**
 * The row of the record that stands for the team's task record `taskId` (the record's event id, hex without `0x`): the
 * plan that binds (the lowest-serial row announced, taken or paid), or else the latest row that ended. Null when the
 * record has no plan on the network. The `what` of a row is `0x` + the id.
 */
export function chainRowOf(
  tasks: ChainTasks,
  taskId: string,
): ChainTask | null {
  const what = `0x${taskId.toLowerCase()}`;
  const rows = tasks.list.filter((row) => row.what === what);
  const live = rows
    .filter(
      (row) =>
        row.state === "announced" ||
        row.state === "taken" ||
        row.state === "paid",
    )
    .sort((a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0));
  if (live[0]) return live[0];
  return (
    [...rows].sort((a, b) =>
      a.serial > b.serial ? -1 : a.serial < b.serial ? 1 : 0,
    )[0] ?? null
  );
}

// --- The phase and its words (5.4) --------------------------------------------------------------------------------

/**
 * The phase of `task` at `now` (seconds): every state the app names, from the row and the clock. A taken task whose
 * deadline has passed is `overdue` here even though the network keeps it `taken` until someone settles; an announced one
 * whose time is up is `missed`. `windDownAt` is the record's wind-down time: an ended row that came to its end at that
 * second was swept by the wind-down, not decided on.
 */
export function phaseOf(
  task: ChainTaskNow & { resolvedAt?: number | null },
  now: number,
  windDownAt: number | null = null,
): Phase {
  switch (task.state) {
    case "announced":
      return now < task.noticeEnd
        ? "notice"
        : now < task.expiresAt
          ? "open"
          : "missed";
    case "taken":
      return now < (task.deadline ?? task.expiresAt) ? "working" : "overdue";
    case "paid":
      return "paid";
    case "rejected":
      return "sent-back";
    case "returned":
    case "cancelled": {
      const swept =
        windDownAt !== null &&
        task.resolvedAt !== null &&
        task.resolvedAt === windDownAt;
      if (swept) return "wound-down";
      return task.state === "returned" ? "ran-out" : "withdrawn";
    }
    case "lapsed":
      return "lapsed";
  }
}

/** What stateWords may be told besides the row and the clock. */
export interface StateOptions {
  /** The record's wind-down time (`numbers.windDown?.at`), so a sweep reads as "Closed". */
  windDownAt?: number | null;
  /** The pay-to's name; without it the detail says "Whoever takes it" for an open task and the wallet's start otherwise. */
  payeeName?: string | null;
}

/** "0x3c44…93bc": a wallet the app has no name for, short enough for a line (the full address is always in the details). */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The words for a task's state at `now` (5.4): a headline and, when there is one, a detail line. The network's state, never
 * the team's record: a record that says "Accepted" while the network says `taken` still reads "Taken, due {date}."
 */
export function stateWords(
  task: ChainTask,
  now: number,
  options: StateOptions = {},
): { headline: string; detail: string | null } {
  const phase = phaseOf(task, now, options.windDownAt ?? null);
  const who =
    options.payeeName ??
    (task.payee ? shortAddress(task.payee) : "Whoever takes it");
  const would = `${who} would be paid up to ${dollarsPhrase(task.maxDollars)}.`;
  const aside = `${dollarsPhrase(task.setAside)} ${task.setAside === 1_000_000n ? "is" : "are"} set aside for it.`;
  switch (phase) {
    case "notice":
      return {
        headline: `Planned. Can be taken from ${timeText(task.noticeEnd)}.`,
        detail: would,
      };
    case "open":
      return {
        headline: `Can be taken now, until ${timeText(task.expiresAt)}.`,
        detail: would,
      };
    case "missed":
    case "lapsed":
      return {
        headline: "Lapsed. Nobody took it in time.",
        detail: "Nothing moved.",
      };
    case "working":
      return {
        headline: `Taken, due ${timeText(task.deadline ?? task.expiresAt)}.`,
        detail: aside,
      };
    case "overdue":
      return {
        headline: "Ran out. The money goes back to the project.",
        detail: "Anyone can return it now.",
      };
    case "paid":
      return {
        headline: `Paid ${dollarsPhrase(task.pay)}.`,
        detail:
          task.pay < task.setAside
            ? `Paid ${dollarsPhrase(task.pay)} of the ${dollarsPhrase(task.setAside)} set aside; the rest went back.`
            : null,
      };
    case "sent-back":
      return {
        headline: "Sent back. Nothing was paid.",
        detail: "The money went back to the project.",
      };
    case "ran-out":
      return {
        headline: "Ran out. Nothing was paid.",
        detail: "The money went back to the project.",
      };
    case "withdrawn":
      return {
        headline: "Withdrawn.",
        detail: "Nobody took it, so no money moved.",
      };
    case "wound-down":
      return {
        headline: "Closed. The project wound down.",
        detail: "Nothing was paid. Any money set aside went back.",
      };
  }
}

/**
 * The next date something happens on `task` after `now`: the take date while it is in its notice, the end of the take
 * window while it can be taken, the due date while it is taken; null when none (it ended, or its time is already up).
 */
export function nextDateOf(task: ChainTask, now: number): number | null {
  const phase = phaseOf(task, now);
  if (phase === "notice") return task.noticeEnd;
  if (phase === "open") return task.expiresAt;
  if (phase === "working") return task.deadline ?? task.expiresAt;
  return null;
}

// --- Open until someone settles: what counts as open and what can be pressed (1.6, 5.6, 5.7, 5.9) ----------------

/**
 * A task is open in the book until a call settles it, even after its time is up (the contract settles first in every call).
 * True for a row that is announced or taken and whose end has passed: the app counts it as ended wherever it matters.
 */
export function isPastEnd(task: ChainTaskNow, now: number): boolean {
  if (task.state === "announced") return now >= task.expiresAt;
  if (task.state === "taken") return now >= (task.deadline ?? task.expiresAt);
  return false;
}

/** How many of `rows` count against the limit on open tasks at `now`: open on the network and not past their end. */
export function openCountAt(
  rows: readonly ChainTaskNow[],
  now: number,
): number {
  return rows.filter(
    (row) =>
      (row.state === "announced" || row.state === "taken") &&
      !isPastEnd(row, now),
  ).length;
}

/** "Withdraw the plan" is offered while nobody has taken it and its time is not up. */
export function canWithdraw(task: ChainTaskNow, now: number): boolean {
  return task.state === "announced" && now < task.expiresAt;
}

/** "Send the money back" is offered while the task is taken and its deadline has not passed (after it the contract settles first). */
export function canSendBack(task: ChainTaskNow, now: number): boolean {
  return task.state === "taken" && now < (task.deadline ?? task.expiresAt);
}

/** "Return the money" is offered on a taken task past its deadline that nobody has settled. */
export function canReturn(task: ChainTaskNow, now: number): boolean {
  return task.state === "taken" && now >= (task.deadline ?? task.expiresAt);
}

/**
 * What a note of `face` pays on `task` at `now`: nothing while the task is running (or when it was paid in full or nothing
 * came back); `face x returned / setAside` once it ended (the contract's own rounding, down); the whole `face` for a taken
 * task past its deadline that nobody settled, because a claim settles first and returns all of it. A sheet checks this
 * against the chain's `claimableNote` when it opens.
 */
export function claimableNow(
  task: ChainTaskNow,
  face: bigint,
  now: number,
): bigint {
  if (face === 0n || task.state === "announced") return 0n;
  if (task.state === "taken")
    return now >= (task.deadline ?? task.expiresAt) ? face : 0n;
  // Ended: nothing came back (paid in full), or the task never held money.
  if (task.setAside === 0n || task.returned === 0n) return 0n;
  return (face * task.returned) / task.setAside;
}

// --- The tie between a network task and the team's task record (3.1, 4.4) ---------------------------------------

const lower = (v: string | null | undefined) => (v ?? "").toLowerCase();

/**
 * Whether the network task `chain` ties to the team's task record `relay` (pure; the relay task is the app's own reading
 * of kind 47003). Returns the first failure, in this order: `no-record`, `what`, `closed`, `already-paid`, `amount`,
 * `payee`, `taker`, `repeat`, `worker-left`, `not-taken`. When it fails the app shows the network's numbers and not the
 * record's words, and Accept is off. One plan binds a task record: the lowest-serial row announced, taken or paid; a later
 * one is a repeat (`repeatOf`) and never ties.
 */
export function tieOf(chain: ChainTask, relay: ProjectTask | null): Tie {
  const no = (why: Extract<Tie, { ok: false }>["why"]): Tie => ({
    ok: false,
    why,
  });
  if (relay === null) return no("no-record");
  if (chain.what !== `0x${relay.id.toLowerCase()}`) return no("what");
  if (relay.state === "cancelled" || relay.state === "given-up")
    return no("closed");
  if (relay.state === "accepted" && relay.paidTx !== null)
    return no("already-paid");
  // A task with no pay stated does not tie: the plan's most must be the pay.
  if (relay.usd === null || chain.maxDollars !== BigInt(relay.usd) * 1_000_000n)
    return no("amount");
  if (chain.payee === null || relay.payTo === null) return no("payee");
  if (lower(chain.payee) !== lower(relay.payTo)) return no("payee");
  if (
    (chain.state === "taken" || chain.state === "paid") &&
    lower(chain.takenBy) !== lower(relay.payTo)
  )
    return no("taker");
  if (chain.repeatOf !== null) return no("repeat");
  if (relay.worker === null) return no("worker-left");
  if (relay.state === "open" || relay.state === "offered")
    return no("not-taken");
  return { ok: true };
}

/**
 * The team's own words for a plan, when the record is the one the plan was made for: the id in `what` is the hash of the
 * signed record, so a record whose id is `what` cannot have other words than the ones planned. Unlike `tieOf` it does not
 * look at the pay or the wallet, so a task that has since been paid or stopped (where `tieOf` rightly fails) still reads in
 * its own words ("\u201cTranslate the guide\u201d was paid ...") and not as "a task". Null with no record or another one.
 */
export function recordWordsOf(
  chain: ChainTask,
  relay: ProjectTask | null,
): string | null {
  return relay !== null && chain.what === `0x${relay.id.toLowerCase()}`
    ? relay.what
    : null;
}

// --- Whether Accept may be offered (5.5) -------------------------------------------------------------------------

/** A press that has to land before the deadline needs some room: closer than this is refused (the clock may be a little off). */
const DEADLINE_ROOM_SECS = 60;

/**
 * Whether Accept may be offered. `fresh` is `taskOf(serial)` read from the chain now, `shown` the row the card showed,
 * `relay` the team's record, `now` the one clock, `me` the signed-in account's key and `address` the connected wallet. It
 * runs `tieOf` on the fresh read and adds: the state is taken, the deadline is not near, the sender runs the project and is
 * not checking their own work, and money is set aside. A failure carries the one sentence to show, and whether "Send the
 * money back" is offered beside it (it is while the task is taken and its deadline has not passed).
 */
export function acceptGate(input: {
  fresh: ChainTaskNow;
  shown: ChainTask;
  relay: ProjectTask | null;
  now: number;
  me: string;
  address: string | null;
  runner: ProjectNumbers["runner"];
  team: ReadonlySet<string>;
  links: WorkerLinks;
}): { ok: true } | { ok: false; sentence: string; sendBackOffered: boolean } {
  const { fresh, shown, relay, now } = input;
  const stop = (sentence: string) => ({
    ok: false as const,
    sentence,
    sendBackOffered: canSendBack(fresh, now) && fresh.setAside > 0n,
  });
  // The network's numbers now, with what only the record's history knows (a repeat) carried over from the row shown.
  const row: ChainTask = {
    ...shown,
    ...fresh,
    pay: fresh.state === "paid" ? fresh.setAside - fresh.returned : shown.pay,
  };
  if (fresh.state !== "taken") return stop(notWaitingForPay(phaseOf(row, now)));
  const deadline = fresh.deadline ?? fresh.expiresAt;
  if (now + DEADLINE_ROOM_SECS >= deadline)
    return stop(deadlinePassed(deadline, now));
  const tie = tieOf(row, relay);
  if (!tie.ok) {
    if (tie.why === "taker")
      return stop(takerDiffers(row.takenBy ?? "nobody", relay?.payTo ?? null));
    if (tie.why === "repeat")
      return stop(plannedMoreThanOnce(row.repeatOf ?? 0n));
    return stop(notThisTask(tie.why));
  }
  const runs =
    input.address !== null &&
    (isRunner({ runner: input.runner } as ProjectNumbers, input.address) ||
      signsForRunner(
        { runner: input.runner } as ProjectNumbers,
        input.address,
      ));
  if (!runs) return stop(NOT_RUNNER);
  if (relay && checksOwnWork(relay, input.me, input.team, input.links))
    return stop(OWN_WORK);
  if (fresh.setAside === 0n) return stop(NOTHING_SET_ASIDE);
  return { ok: true };
}
