import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import type { ProjectNumbers } from "../money/numbers";
import { useMoneySend } from "../money/use-money";
import type { Project } from "../project/project-record";
import { forgetPaid, paidNotRecorded, rememberPaid } from "./paid-journal";
import {
  PAIR_ALONE_DOLLARS,
  pairSpendCall,
  treasurySpendCall,
} from "./task-calls";
import { acceptRecord, type ProjectTask } from "./task-record";
import { dollarsWords, payProblem, TASK_PROBLEM } from "./tasks-copy";
import { freshTask, useTaskWrite } from "./use-tasks";

/** How the work's payment can be sent from the wallet this site sees, or why it cannot. */
export type PayRoute =
  | { kind: "treasury"; treasury: string; chainId: number }
  | { kind: "pair"; pair: string; chainId: number }
  | { kind: "none"; why: string };

/**
 * Who pays and how: the runner's own wallet through the Treasury, or one of a Pair's signers alone up to 500 dollars.
 * Never the server, never an agent.
 */
function payRoute(
  numbers: ProjectNumbers | null,
  address: string | null,
  usd: number,
): PayRoute {
  const treasury = numbers?.contracts.treasury ?? null;
  if (!numbers || !treasury || !numbers.runner)
    return { kind: "none", why: TASK_PROBLEM.notRunner };
  const pair = numbers.market.pair;
  if (pair && numbers.runner === pair.toLowerCase()) {
    if (usd > PAIR_ALONE_DOLLARS)
      return { kind: "none", why: TASK_PROBLEM.pairAboveAlone };
    return { kind: "pair", pair, chainId: numbers.chainId };
  }
  if (address && numbers.runner === address.toLowerCase())
    return { kind: "treasury", treasury, chainId: numbers.chainId };
  return { kind: "none", why: TASK_PROBLEM.notRunner };
}

/** Whether the task, read fresh, is no longer the one the press was about to pay for. */
function moved(
  now: ProjectTask | null,
  task: ProjectTask,
  piece: string,
  payee: string,
): boolean {
  if (now === null) return true;
  return (
    now.state !== "submitted" ||
    now.handIn?.id !== piece ||
    now.worker !== task.worker ||
    now.payTo !== payee
  );
}

/**
 * Accept handed-in work and pay for it: one press. The task is read again first and the press stops if it has moved
 * (someone gave it up, handed in again, cancelled it): money sent for a record the server then refuses cannot be taken
 * back. The money goes next, from the wallet; the record that the work was accepted names its transaction and goes
 * last. A payment whose record failed is remembered (`paid-journal.ts`), so the next press writes the record, for the
 * piece that was paid for, and never pays again. With money off the press only accepts the work. A task that pays but
 * whose taker named no wallet cannot be paid: accepting it is a second, plainly worded choice (two presses), never the
 * ordinary button.
 */
export function AcceptAndPay({
  project,
  task,
  numbers,
  address,
}: {
  project: Project;
  task: ProjectTask;
  /** The project's numbers when the server turns money on, else null: then nothing is paid here. */
  numbers: ProjectNumbers | null;
  address: string | null;
}) {
  const write = useTaskWrite(project);
  const send = useMoneySend(`task-pay:${task.id}`);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [looking, setLooking] = useState(false);
  const handIn = task.handIn;
  if (!handIn) return null;
  const owed = paidNotRecorded(task.id);
  const usd = task.usd ?? 0;
  const paying = numbers !== null && usd > 0;
  const route = paying ? payRoute(numbers, address, usd) : null;
  const payee = task.payTo;
  const blocked =
    paying && !owed ? (route?.kind === "none" ? route.why : null) : null;

  const record = (txHash: string | null, piece: string) =>
    write.mutate(
      {
        record: acceptRecord(project.coordinate, task, piece, txHash),
        failure: txHash ? TASK_PROBLEM.recordAfterPay : TASK_PROBLEM.accept,
      },
      {
        onSuccess: () => {
          forgetPaid(task.id);
          toast(
            txHash
              ? `Accepted and paid ${dollarsWords(usd)}.`
              : "Work accepted.",
            "done",
          );
        },
        onError: (error) =>
          setProblem(txHash ? TASK_PROBLEM.recordAfterPay : error.message),
      },
    );

  const press = async () => {
    setProblem(null);
    // The payment's record goes against the piece that was paid for, even if newer work was handed in since.
    if (owed) return record(owed.txHash, owed.handIn);
    if (!paying) return record(null, handIn.id);
    if (!payee) {
      if (!sure) return setSure(true);
      return record(null, handIn.id);
    }
    if (!route || route.kind === "none") return;
    setLooking(true);
    const now = await freshTask(queryClient, project, task.id);
    setLooking(false);
    if (moved(now, task, handIn.id, payee))
      return setProblem(TASK_PROBLEM.changed);
    send.send(
      {
        chainId: route.chainId,
        detail: task.id.slice(0, 16),
        build: () => [
          route.kind === "pair"
            ? pairSpendCall(route.pair, payee, usd)
            : treasurySpendCall(route.treasury, payee, usd),
        ],
      },
      {
        onSuccess: (result) => {
          rememberPaid({
            task: task.id,
            handIn: handIn.id,
            txHash: result.txHash,
            at: Math.floor(Date.now() / 1000),
          });
          record(result.txHash, handIn.id);
        },
        onError: (error) => setProblem(payProblem(error)),
      },
    );
  };

  const busy = send.isPending || write.isPending || looking;
  const unpaid = paying && !payee && !owed;
  const label = owed
    ? "Save that it was paid"
    : unpaid
      ? sure
        ? "Yes, accept it without paying"
        : `Accept without paying ${dollarsWords(usd)}`
      : paying
        ? `Accept and pay ${dollarsWords(usd)}`
        : "Accept the work";
  return (
    <div className="flex flex-col gap-2">
      {unpaid ? (
        <p className="text-sm text-muted" data-testid="task-no-payee">
          {sure ? TASK_PROBLEM.noPayeeSure : TASK_PROBLEM.noPayee}
        </p>
      ) : null}
      {problem || blocked ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="task-accept-problem"
          role="alert"
        >
          {problem ?? blocked}
        </p>
      ) : null}
      {blocked && payee ? null : (
        <Button
          block
          data-testid="task-accept"
          disabled={busy}
          onClick={() => void press()}
          variant={unpaid ? "secondary" : "primary"}
        >
          {busy ? "Waiting…" : label}
        </Button>
      )}
    </div>
  );
}
