/**
 * What the sheets that act on a task already on the network read when they open, and again right before the press (plan
 * sections 5.0, 5.5, 5.6 and 5.7): the task as the chain has it this second and the chain's own clock. Nothing here sends.
 * A task the row of the signed record showed is never carried into a press: this read is what the press is built from.
 */
import {
  type ChainTaskNow,
  type ReadCall,
  readBookOf,
  readTask,
} from "@creaton/core/pot/pot-reads.ts";
import type { MoneyWallet } from "../../../money/wallet";
import { phaseOf } from "../state";
import { changedWhileLooking } from "../words";

/** The task as the chain says it now, with the book it lives in and the chain's clock. */
export interface TaskNow {
  book: string;
  task: ChainTaskNow;
  /** The time of the chain's latest block, or the fallback when the network cannot say it. */
  time: number;
}

/**
 * Reads task `serial` of the project's book, and the time of the latest block. A book the Treasury does not have, a task that
 * does not exist or any read that fails throws: a press is never built on a guess.
 */
export async function readTaskNow(
  source: { read: ReadCall; wallet: Pick<MoneyWallet, "blockTime"> },
  treasury: string,
  serial: bigint,
  fallbackNow: number,
): Promise<TaskNow> {
  const { read, wallet } = source;
  const book = await readBookOf(read, treasury);
  if (book === null)
    throw new Error("This project has no place to keep tasks on the network.");
  const [task, time] = await Promise.all([
    readTask(read, book, serial),
    wallet.blockTime
      ? wallet.blockTime("latest").catch(() => fallbackNow)
      : Promise.resolve(fallbackNow),
  ]);
  if (task === null) throw new Error("The network does not know that task.");
  return { book, task, time };
}

/** Whether the task moved between what a sheet showed and what the chain says now: anything a press depends on differs. */
export function movedSince(shown: ChainTaskNow, fresh: ChainTaskNow): boolean {
  return (
    shown.state !== fresh.state ||
    shown.takenBy !== fresh.takenBy ||
    shown.setAside !== fresh.setAside ||
    shown.deadline !== fresh.deadline ||
    shown.expiresAt !== fresh.expiresAt ||
    shown.payee !== fresh.payee ||
    shown.what !== fresh.what
  );
}

/**
 * The last look before a press: the sentence when the task is no longer what the sheet showed (and nothing is sent), or null
 * to go on. When a send of this very step may have landed (`waiting`) and the task is now in the state that step makes
 * (`result`), that is the send having landed, not a change: null, and the sheet looks for it instead of sending anything.
 */
export function stillSo(input: {
  shown: ChainTaskNow;
  fresh: TaskNow;
  waiting: boolean;
  result: ChainTaskNow["state"];
  windDownAt?: number | null;
}): string | null {
  const { shown, fresh } = input;
  if (input.waiting && fresh.task.state === input.result) return null;
  if (!movedSince(shown, fresh.task)) return null;
  return changedWhileLooking(
    phaseOf(fresh.task, fresh.time, input.windDownAt ?? null),
  );
}
