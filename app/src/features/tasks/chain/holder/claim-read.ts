/**
 * What the Claim sheet reads from the network when it opens, and again right before the press (plan section 5.9): the task,
 * the connected account's claim on it, what the network says a claim would pay, and the network's clock. The figure a press
 * is made from is this one, never the record's.
 */
import {
  type ChainTaskNow,
  readClaimable,
  readNoteOf,
} from "@creaton/core/pot/pot-reads.ts";
import type { Ready } from "../../../pot/use-pot";
import { claimableNow, isPastEnd } from "../state";
import { type TaskNow, readTaskNow } from "../team/task-now";
import { CLAIM_BLOCK, claimNotYet } from "./notes-words";

/** A task and the account's claim on it as the network says it now. */
export interface ClaimRead extends TaskNow {
  /** The face of the account's claim; zero once it was claimed (or never existed). */
  face: bigint;
  /** What the network's own view says a claim would pay now: zero while the task is running, and for a task that ran out and nobody has settled. */
  view: bigint;
}

export async function readClaim(
  ready: Ready,
  treasury: string,
  serial: bigint,
  fallbackNow: number,
): Promise<ClaimRead> {
  const now = await readTaskNow(ready, treasury, serial, fallbackNow);
  const [face, view] = await Promise.all([
    readNoteOf(ready.read, now.book, serial, ready.address),
    readClaimable(ready.read, now.book, serial, ready.address),
  ]);
  return { ...now, face, view };
}

/** What a claim would pay now, and why not when it would pay nothing or cannot be sent yet. */
export interface ClaimFigure {
  /** What the claim pays: the network's own figure for an ended task, the whole claim for one that ran out and nobody settled. */
  claimable: bigint;
  /** The task ran out and nobody has returned its money: the claim settles it first. */
  overdue: boolean;
  /** One sentence that says why there is no press, or null. */
  block: string | null;
}

function blocked(block: string, overdue = false): ClaimFigure {
  return { claimable: 0n, overdue, block };
}

/** The figure of a claim on `task` at `now`, from what the network says. Pure. */
export function claimFigure(
  read: { task: ChainTaskNow; face: bigint; view: bigint },
  now: number,
): ClaimFigure {
  const { task, face, view } = read;
  if (face === 0n) return blocked(CLAIM_BLOCK.nothing);
  const open = task.state === "announced" || task.state === "taken";
  if (open && !isPastEnd(task, now))
    return blocked(claimNotYet(task.deadline ?? task.expiresAt));
  // A task that ran out and nobody has settled: the network's view reads zero, and a claim settles first and pays it all.
  if (open) return { claimable: face, overdue: true, block: null };
  if (task.returned === 0n) return blocked(CLAIM_BLOCK.nothing);
  const formula = claimableNow(task, face, now);
  // The contract's own rounding is what a claim pays: a view that says another figure is not acted on.
  if (formula !== view) return blocked(CLAIM_BLOCK.inconsistent);
  return view === 0n
    ? blocked(CLAIM_BLOCK.nothing)
    : { claimable: view, overdue: false, block: null };
}
