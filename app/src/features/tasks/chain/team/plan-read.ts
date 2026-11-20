/**
 * What the Plan sheet reads from the network when it opens, and again right before the press (plan section 5.2). The share
 * of the plan comes from the record's pot (with its "as of"); everything a plan stands on that can move (the tasks open now,
 * the notice a plan of this size gets, when the team's check-in stops counting, the allowance box) is read from the chain
 * at that moment. Nothing here sends.
 */
import {
  TASK_BOOK_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { boxOf } from "@creaton/core/pot/pot-state.ts";
import {
  ask,
  asBigint,
  type ChainTaskNow,
  type NoticeFor,
  type ReadCall,
  readActiveEnd,
  readBookOf,
  readNoticeFor,
  readOpenSerials,
  readTask,
} from "@creaton/core/pot/pot-reads.ts";
import type { MoneyWallet } from "../../../money/wallet";
import type { ProjectTask } from "../../task-record";
import { isPastEnd } from "../state";
import type { ChainTask } from "../types";

/** What a plan stands on, read from the chain at one moment. */
export interface PlanRead {
  /** The project's task book, as the chain says. */
  book: string;
  /** The number the next plan gets. */
  nextSerial: bigint;
  /** Every task announced or taken now (at most eight). */
  open: ChainTaskNow[];
  /** What a plan of this size gets; null when its share does not fit (there is nothing to read). */
  notice: NoticeFor | null;
  /** The second the team's last check-in stops counting. */
  activeEnd: number;
  /** What the allowance box holds, and the most it can hold. */
  box: bigint;
  boxCap: bigint;
  /** The chain's own clock, in seconds. */
  time: number;
}

/**
 * Reads what a plan of `shareBps` (null when the share does not fit) stands on. `fallbackNow` is the clock to use when the
 * network cannot say the time of its latest block. A book the Treasury does not have, or any read that fails, throws: a plan
 * is never sized on a guess.
 */
export async function readPlan(
  source: { read: ReadCall; wallet: Pick<MoneyWallet, "blockTime"> },
  treasury: string,
  shareBps: number | null,
  fallbackNow: number,
): Promise<PlanRead> {
  const { read, wallet } = source;
  const book = await readBookOf(read, treasury);
  if (book === null)
    throw new Error("This project has no place to keep tasks on the network.");
  const [nextSerial, serials, notice, activeEnd, box, boxCap, time] =
    await Promise.all([
      ask(read, TASK_BOOK_ABI, book, "nextSerial", []).then(([n]) =>
        asBigint(n),
      ),
      readOpenSerials(read, book),
      shareBps === null
        ? Promise.resolve(null)
        : readNoticeFor(read, treasury, shareBps),
      readActiveEnd(read, treasury),
      boxOf(read, treasury),
      ask(read, TREASURY_ABI, treasury, "boxCap", []).then(([n]) =>
        asBigint(n),
      ),
      wallet.blockTime
        ? wallet.blockTime("latest").catch(() => fallbackNow)
        : Promise.resolve(fallbackNow),
    ]);
  const rows = await Promise.all(serials.map((s) => readTask(read, book, s)));
  const open = rows.filter((r): r is ChainTaskNow => r !== null);
  return { book, nextSerial, open, notice, activeEnd, box, boxCap, time };
}

/**
 * The plan a task record is on the network now, from what was read: an open task whose `what` is the record's id and whose
 * time is not already up (a task past its end is ended by the next step, so it does not count).
 */
export function plannedAlready(
  read: Pick<PlanRead, "open" | "time">,
  id: string,
): ChainTaskNow | null {
  const what = `0x${id.toLowerCase()}`;
  return (
    read.open.find((r) => r.what === what && !isPastEnd(r, read.time)) ?? null
  );
}

/**
 * The row a plan of `task` would be on the network, as far as the tie to the team's record is concerned: used to ask `tieOf`
 * whether the record could be planned at all, before anything is sent.
 */
export function hypotheticalRow(
  task: ProjectTask,
  maxDollars: bigint,
  shareBps: number,
): ChainTask {
  return {
    serial: 0n,
    what: `0x${task.id.toLowerCase()}`,
    payee: task.payTo,
    state: "announced",
    shareBps,
    takenBy: null,
    announcedAt: 0,
    noticeEnd: 0,
    expiresAt: 0,
    takenAt: null,
    deadline: null,
    maxDollars,
    setAside: 0n,
    stayerClaim: 0n,
    noteFace: 0n,
    returned: 0n,
    notesLeft: 0n,
    atMostNow: null,
    pay: 0n,
    capBps: 0,
    resolvedAt: null,
    resolvedTx: null,
    repeatOf: null,
    notes: null,
  };
}
