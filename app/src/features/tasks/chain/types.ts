/**
 * The shapes the task queue screens build against (`docs/archive/STEP2-SERVER-APP-PLAN.md`, sections 1.3, 1.4 and 4.4).
 *
 * Two readings of a task exist and are never mixed up:
 * - `ChainTask` is a row of the server's signed record (`numbers.tasks.list`): every number in it was checked against the
 *   chain at the record's block, and it is minutes old. It is what lists, strips and alerts read.
 * - `ChainTaskNow` is what the chain says this second (`readTask`): what a sheet reads when it opens and again before it
 *   sends. It is what every press is built from.
 *
 * Amounts are bigint dollar units (6 decimals), serials are bigint, times are unix seconds, shares are ten-thousandths of
 * the project's money. A team member's own task record can say anything; none of these shapes comes from it.
 */
import type {
  ChainTaskNow,
  NoticeFor,
  TaskStateName,
} from "@creaton/core/pot/pot-reads.ts";

export type { ChainTaskNow, NoticeFor };

/**
 * What the book says a task is; `returned` is a task that ran out or was swept by a wind-down.
 *
 * @public Named for the task screens (S1). Drop this tag when a screen uses it.
 */
export type ChainTaskState = TaskStateName;

/**
 * What a leaver holds on one task: the face of the notes, per holder, and what a claim would pay now.
 *
 * @public Named for the task screens (S1). Drop this tag when a screen uses it.
 */
export interface ChainTaskNotes {
  /** The face of every note against the task, listed or not. */
  faceTotal: bigint;
  /** At most 20 holders, largest first; empty with `holdersCut` for rows the record cut. */
  holders: { account: string; face: bigint; claimable: bigint }[];
  holdersCut: boolean;
}

/** One task of the signed record: the chain's own fields (as `ChainTaskNow`) plus what only the server's history knows. */
export interface ChainTask extends ChainTaskNow {
  /**
   * For an announced task whose take window has not ended: the most a take at the record's time would set aside
   * (`min(maxDollars, pot x share)`); null for every other state. A hint for lists, never a promise.
   */
  atMostNow: bigint | null;
  /** What the worker was paid ("0" unless the task was paid). */
  pay: bigint;
  /** What this take still counts in the cap on takes (0 when never taken, or when it ended unpaid and gave its share back). */
  capBps: number;
  /** When it ended (the time of the block that ended it), and the transaction that ended it: the proof a team record names. */
  resolvedAt: number | null;
  resolvedTx: string | null;
  /**
   * The serial of an earlier row with the same `what` that is announced, taken or paid; null for the plan that binds. The
   * plan of a task record is its lowest-serial row in one of those states; every later such row is a repeat and is never paid.
   */
  repeatOf: bigint | null;
  /** Null when no note is held against the task or it was paid in full. */
  notes: ChainTaskNotes | null;
}

/**
 * What the next dated thing on a project's tasks is.
 *
 * @public Named for the task screens (S1). Drop this tag when a screen uses it.
 */
export type ChainNextKind = "can_be_taken" | "lapses" | "due" | "cap_room";

/** The `tasks` section of a record (1.3): the queue, the limits and the room under the cap. */
export interface ChainTasks {
  /** The project's task book. */
  book: string;
  /** The block the book started: the first block it can have logs in (where a look for notes stops). */
  bookBlock: number;
  /** The serial the next plan gets. */
  nextSerial: bigint;
  /** Tasks announced or taken, not ended: at most `limits.maxOpen`. */
  openCount: number;
  /** The earliest second an open task runs out; null when none is open. */
  nextExpiry: number | null;
  limits: {
    maxOpen: number;
    /** The most one task may ask for, in ten-thousandths of the pot (500 is 5%). */
    maxShareBps: number;
    /** The most that may be taken in the rolling window (1000 is 10%). */
    capBps: number;
    /** The smallest task, in dollar units. */
    minTask: bigint;
    /** The rolling window of the cap (28 days on a real network). */
    capWindowSecs: number;
    /** How long a task can be taken after its notice, and how long after a take it is due. */
    takeWindowSecs: number;
    dueSecs: number;
  };
  cap: {
    /** The takes counted in the window now, and the room left under the cap, in ten-thousandths. */
    usedBps: number;
    roomBps: number;
    /** When room comes back, oldest first, at most 16. */
    frees: { at: number; bps: number }[];
  };
  /** The next date something can happen on the queue; null when none. `serial` is 0 for `cap_room`. */
  next: { at: number; kind: ChainNextKind; serial: bigint } | null;
  /** Open tasks first (serial ascending), then ended ones (serial descending): at most 8 open and 32 ended. */
  list: ChainTask[];
  /** How the ended rows were chosen and how many were left out. */
  cut: {
    maxEnded: number;
    endedWithinSecs: number;
    endedDropped: number;
    notesRowsDropped: number;
  };
  /** True when anything above was cut: a cut list never says "none". */
  truncated: boolean;
}
