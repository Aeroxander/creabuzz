/**
 * What the Take sheet reads from the network when it opens, and again right before the press (plan section 5.8): the task as
 * the chain has it this second with the chain's clock, when the project's last check-in stops counting, and the room left
 * under the limit on money set aside for tasks. Nothing is taken from the signed record except what the sheet names.
 */
import { readActiveEnd, readTakeRoom } from "@creaton/core/pot/pot-reads.ts";
import type { Ready } from "../../../pot/use-pot";
import { type TaskNow, readTaskNow } from "../team/task-now";

/** The task and the network's clock (`TaskNow`), with what only taking needs. */
export interface TakeRead extends TaskNow {
  /** The second the last check-in stops counting: after it no task can be taken. */
  activeEnd: number;
  /** The room left under the limit on money set aside for tasks, in ten-thousandths of the project's money. */
  roomBps: number;
}

/** Reads task `serial`, the check-in and the room. Any read that fails throws: a press is never built on a guess. */
export async function readTake(
  ready: Ready,
  treasury: string,
  serial: bigint,
  fallbackNow: number,
): Promise<TakeRead> {
  const [now, activeEnd] = await Promise.all([
    readTaskNow(ready, treasury, serial, fallbackNow),
    readActiveEnd(ready.read, treasury),
  ]);
  const roomBps = await readTakeRoom(ready.read, now.book);
  return { ...now, activeEnd, roomBps };
}
