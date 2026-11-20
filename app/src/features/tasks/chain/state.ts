/**
 * What a task is, from the network's numbers (`docs/next-version/STEP2-SERVER-APP-PLAN.md`, sections 4.4, 5.1, 5.4 and 5.5).
 * Pure functions, no reads: the state a person sees is a function of a row of the signed record and the clock, and a press
 * is gated by a fresh read of the chain (`acceptGate`). A team member's own task record never changes what the app calls a
 * state; it can only fail a tie.
 *
 * S1 (the shared library's first part) fixes the shapes the screens build against. `phaseOf`, `stateWords`, `nextDateOf`,
 * `tieOf`, `acceptGate`, `doorFor`, `shareFor`, `noticeWords` and `durationWords` have their signatures here and bodies
 * that throw until S2 builds them; `nowOf` and `chainRowOf` are built.
 */
import type { ProjectTask } from "../task-record";
import type { ChainTask, ChainTaskNow, ChainTasks, NoticeFor } from "./types";

/**
 * Where a task is, by the dates and the network's state (5.4):
 * a plan in its notice, open to be taken, missed (nobody took it in time), taken and working, taken and overdue (ran out,
 * not yet returned), or ended in one of five ways. `wound-down` is an ended row whose `resolvedAt` equals the record's
 * wind-down time: the sweep, not a decision about the task.
 *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
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

/** Whether a network task ties to the team's task record, and the first reason it does not (in this order). *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
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

/** The way a task is paid (5.1): from the allowance box, only from it, as a plan with notice, or not at all (too big). *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export type Door = {
  door: "box" | "box-only" | "plan" | "too-big";
  /** The one sentence shown beside the press, always. */
  sentence: string;
  /** True when the proposed door is the box and a plan would also fit: "Plan it instead, so holders get notice first." */
  planAlso: boolean;
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

/** Raised by a function whose body the second part of the shared library (S2) builds. */
function notBuilt(name: string, ..._inputs: unknown[]): never {
  throw new Error(`chain/state.ts: ${name} is not built yet (step 2, S2)`);
}

/** The phase of `task` at `now` (seconds): every state the app names, from the row and the clock. *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function phaseOf(task: ChainTask, now: number): Phase {
  return notBuilt("phaseOf", task, now);
}

/** The words for a task's state at `now` (5.4): a headline and, when there is one, a detail line. *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function stateWords(
  task: ChainTask,
  now: number,
): { headline: string; detail: string | null } {
  return notBuilt("stateWords", task, now);
}

/** The next date something happens on `task` after `now`: the take date, the end of the take window, or the due date; null when none. *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function nextDateOf(task: ChainTask, now: number): number | null {
  return notBuilt("nextDateOf", task, now);
}

/**
 * Whether the network task `chain` ties to the team's task record `relay` (pure; the relay task is the app's own reading
 * of kind 47003). Returns the first failure, in this order: `no-record`, `what`, `closed`, `already-paid`, `amount`,
 * `payee`, `taker`, `repeat`, `worker-left`, `not-taken`. When it fails the app shows the network's numbers and not the
 * record's words, and Accept is off.
 *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function tieOf(chain: ChainTask, relay: ProjectTask | null): Tie {
  return notBuilt("tieOf", chain, relay);
}

/**
 * Whether Accept may be offered. `fresh` is `taskOf(serial)` read from the chain now, `shown` the row the card showed,
 * `relay` the team's record, `me` the sender. It runs `tieOf` on the fresh read and adds: the state is taken, the deadline
 * is not past, the sender runs the project. A failure carries the one sentence to show, and whether "Send the money back"
 * is offered beside it (it is whenever money is set aside).
 *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function acceptGate(input: {
  fresh: ChainTaskNow;
  shown: ChainTask;
  relay: ProjectTask | null;
  now: number;
  me: string;
}): { ok: true } | { ok: false; sentence: string; sendBackOffered: boolean } {
  return notBuilt("acceptGate", input);
}

/**
 * The door for paying a task (5.1): `usd` the pay in dollars, `box` what the allowance box holds now, `boxCap` the most it
 * can hold, `pot` the project's money, `payee` the wallet the worker named, `runner` who runs the project, `limits` the
 * record's limits and `notice` what a plan of this size gets (null when it could not be read).
 *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function doorFor(input: {
  usd: number;
  box: bigint;
  boxCap: bigint;
  pot: bigint;
  payee: string | null;
  runner: { address: string; signers: string[] | null };
  limits: ChainTasks["limits"];
  notice: NoticeFor | null;
}): Door {
  return notBuilt("doorFor", input);
}

/**
 * The share of the pot a plan asks for, in ten-thousandths: `ceil(maxDollars x 11,000 / pot)` in whole numbers (a tenth
 * more than the pay's own share, so a small fall does not short-change the worker), at least 1; null when it passes
 * `maxShareBps` or the pot is nothing.
 *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function shareFor(
  maxDollars: bigint,
  pot: bigint,
  maxShareBps: number,
): number | null {
  return notBuilt("shareFor", maxDollars, pot, maxShareBps);
}

/** A notice in words, "16 days 12 hours"; on a test network "1 hour 17 minutes". *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function noticeWords(secs: number): string {
  return notBuilt("noticeWords", secs);
}

/** A length of time in words, the same units as `noticeWords`. *
 * @public Signature for the task screens (S1); built by S2. Drop this tag when a screen uses it.
 */
export function durationWords(secs: number): string {
  return notBuilt("durationWords", secs);
}
