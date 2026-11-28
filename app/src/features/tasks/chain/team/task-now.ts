/**
 * What the Claim sheet and the anvil loop read of a task already on the network (plan sections 5.0 and 5.9): the task as the
 * chain has it this second and the chain's own clock. Nothing here sends. A task the row of the signed record showed is never
 * carried into a press: this read is what the press is built from.
 */
import {
  type ChainTaskNow,
  type ReadCall,
  readBookOf,
  readTask,
} from "@creaton/core/pot/pot-reads.ts";
import type { MoneyWallet } from "../../../money/wallet";

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
