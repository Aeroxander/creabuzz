/**
 * What a task is, from the network's numbers (`docs/next-version/STEP2-SERVER-APP-PLAN.md`, sections 4.4, 5.1 and 5.4).
 * Pure functions, no reads: the state a person sees is a function of a row of the signed record and the clock. A team
 * member's own task record never changes what the app calls a state; it can only fail a tie.
 */
import type { ProjectTask } from "../task-record";
import type { ChainTask, ChainTaskNow, ChainTasks } from "./types";

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
