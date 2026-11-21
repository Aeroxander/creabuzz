/**
 * Writing the team's record that a task was paid (plan section 5.5), after the network paid it. The transaction named in the
 * record is read from the network by the task's number (`paid-tx.ts`), never taken from what a sheet sent, and is written only
 * once the network says the task is paid. A payment whose record failed is remembered (`paid-journal.ts`) so the next press
 * writes the record and never pays twice; the card offers that press as long as the record is missing.
 */
import { useState } from "react";
import { useToast } from "../../../../ui/toast";
import type { Project } from "../../../project/project-record";
import type { Ready } from "../../../pot/use-pot";
import { forgetPaid, paidNotRecorded, rememberPaid } from "../../paid-journal";
import { acceptRecord, type ProjectTask, payRecord } from "../../task-record";
import { recordProblem, TASK_PROBLEM } from "../../tasks-copy";
import { useTaskWrite } from "../../use-tasks";
import type { ChainTask } from "../types";
import {
  PAID_NOT_FOUND,
  PAID_NOT_YET,
  PAID_RETRY,
  PAID_SAVED,
} from "./pay-words";
import { readPaidTx } from "./paid-tx";
import { readTaskNow } from "./task-now";

/** Whether the team's record can say this task was paid: work handed in and not yet marked paid. */
export function recordOwed(task: ProjectTask): boolean {
  return (
    task.handIn !== null &&
    ((task.state === "submitted" && task.paidTx === null) ||
      (task.state === "accepted" && task.paidTx === null))
  );
}

export function useSavePaid(input: {
  project: Project;
  task: ProjectTask;
  treasury: string;
  bookBlock: number;
  /** The row the card shows (its `resolvedTx` is a fallback when the log cannot be read). */
  chain: ChainTask | null;
  fallbackNow: number;
}) {
  const { project, task, chain } = input;
  const write = useTaskWrite(project);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Looks at the network, and writes the record when the task is paid there. Resolves true when the record was written. */
  const save = async (
    ready: Ready,
    paidPiece: string | null = null,
  ): Promise<boolean> => {
    if (busy || chain === null) return false;
    setProblem(null);
    setBusy(true);
    try {
      const remembered = paidNotRecorded(task.id);
      // The piece that was paid for: the journal's, else the one the press looked at last, else the record's current one.
      const piece = remembered?.handIn ?? paidPiece ?? task.handIn?.id ?? null;
      if (piece === null) return false;
      let now: Awaited<ReturnType<typeof readTaskNow>>;
      try {
        now = await readTaskNow(
          ready,
          input.treasury,
          chain.serial,
          input.fallbackNow,
        );
      } catch {
        setProblem(PAID_NOT_FOUND);
        return false;
      }
      if (now.task.state !== "paid") {
        setProblem(PAID_NOT_YET);
        return false;
      }
      let tx: string | null = null;
      try {
        tx = await readPaidTx(
          ready.wallet,
          now.book,
          chain.serial,
          input.bookBlock,
        );
      } catch {
        tx = null;
      }
      tx ??= remembered?.txHash ?? chain.resolvedTx;
      if (tx === null) {
        setProblem(PAID_NOT_FOUND);
        return false;
      }
      rememberPaid({
        task: task.id,
        handIn: piece,
        txHash: tx,
        at: Math.floor(Date.now() / 1000),
      });
      const record =
        task.state === "accepted"
          ? payRecord(project.coordinate, task, piece, tx)
          : acceptRecord(project.coordinate, task, piece, tx);
      try {
        await write.mutateAsync({
          record,
          failure: TASK_PROBLEM.recordAfterPay,
        });
      } catch (error) {
        // The server has not read the payment yet ("try again in a minute"), or the network does not show it paying this task:
        // said in words, and the task is not marked paid.
        setProblem(recordProblem(error, PAID_RETRY));
        return false;
      }
      forgetPaid(task.id);
      toast(PAID_SAVED, "done");
      return true;
    } finally {
      setBusy(false);
    }
  };
  return { save, busy, problem };
}
