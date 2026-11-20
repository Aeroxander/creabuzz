/**
 * Whether the person who is named for a task can take it now, and the one sentence that says why not (plan section 5.8).
 * Pure, from what the sheet read from the network. The order is the order a person would fix things in: who may take it,
 * what state it is in, the notice, the take window, the team's check-in, the room under the limit. The contract decides every
 * one of them again at the press; this only says in advance why it would refuse.
 */
import {
  isRunner,
  type ProjectNumbers,
  signsForRunner,
} from "../../../money/numbers";
import type { ChainTasks } from "../types";
import {
  OPEN_TO_ANYONE,
  TAKE_BLOCK,
  takeCap,
  takeNotice,
  takeNotPayee,
} from "./holder-words";
import type { TakeRead } from "./take-read";

const BPS = 10_000n;

/** What a take at the project's money in the record would set aside now: the smaller of the most and its share, rounded down. */
export function atMostOf(max: bigint, shareBps: number, pot: bigint): bigint {
  const share = (pot * BigInt(shareBps)) / BPS;
  return share < max ? share : max;
}

/** What a take of `amount` counts in the limit, in ten-thousandths of the project's money: rounded up, against the taker. */
function countedBps(amount: bigint, pot: bigint): number {
  return pot === 0n ? 0 : Number((amount * BPS + pot - 1n) / pot);
}

/**
 * When enough room will have come back for `need` ten-thousandths, by the dates the record lists, or null when the list does
 * not say (it is cut at 16 takes). `room` is what is free now.
 */
export function roomBackAt(
  frees: ChainTasks["cap"]["frees"],
  room: number,
  need: number,
  now: number,
): number | null {
  let free = room;
  for (const f of [...frees].sort((a, b) => a.at - b.at)) {
    if (f.at <= now) continue;
    free += f.bps;
    if (free >= need) return f.at;
  }
  return null;
}

/** Why the task cannot be taken now, or null when it can. `now` is the chain's clock lifted to the record's. */
export function takeBlock(input: {
  read: TakeRead;
  numbers: ProjectNumbers;
  queue: ChainTasks;
  /** The account that would send. */
  address: string;
  now: number;
}): string | null {
  const { read, numbers, queue, address, now } = input;
  const task = read.task;
  if (numbers.windDown) return TAKE_BLOCK.wound;
  if (isRunner(numbers, address) || signsForRunner(numbers, address))
    return TAKE_BLOCK.runs;
  if (task.payee === null) return OPEN_TO_ANYONE;
  if (task.payee.toLowerCase() !== address.toLowerCase())
    return takeNotPayee(task.payee);
  if (task.state !== "announced") return TAKE_BLOCK.state;
  if (now < task.noticeEnd) return takeNotice(task.noticeEnd);
  if (now >= task.expiresAt) return TAKE_BLOCK.over;
  if (read.activeEnd <= now) return TAKE_BLOCK.quiet;
  // The book's own room still counts a take that ran past its deadline and nobody settled; a take settles first and frees it.
  // So the press is stopped only when the record's room, which counts that, is short as well: a hidden press is the worse error.
  const atMost = atMostOf(task.maxDollars, task.shareBps, numbers.money.pot);
  const need = countedBps(atMost, numbers.money.pot);
  const room = Math.max(read.roomBps, queue.cap.roomBps);
  if (need > room)
    return takeCap({
      used: queue.limits.capBps - room,
      add: need,
      cap: queue.limits.capBps,
      backAt: roomBackAt(queue.cap.frees, room, need, now),
    });
  return null;
}
