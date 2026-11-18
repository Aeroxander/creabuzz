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
import { useTaskWrite } from "./use-tasks";

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

/**
 * Accept handed-in work and pay for it: one press. The money goes first, from the wallet; the record that the work was
 * accepted names its transaction and goes second. A payment whose record failed is remembered (`paid-journal.ts`), so
 * the next press writes the record and never pays again. With money off, or a task that pays nothing here, the press
 * only accepts the work.
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
  const [problem, setProblem] = useState<string | null>(null);
  const handIn = task.handIn;
  if (!handIn) return null;
  const owed = paidNotRecorded(task.id);
  const usd = task.usd ?? 0;
  const paying = numbers !== null && usd > 0;
  const route = paying ? payRoute(numbers, address, usd) : null;
  const payee = task.payTo;
  const blocked =
    paying && !owed ? (route?.kind === "none" ? route.why : null) : null;

  const record = (txHash: string | null) =>
    write.mutate(
      {
        record: acceptRecord(project.coordinate, task, handIn.id, txHash),
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

  const press = () => {
    setProblem(null);
    if (owed) return record(owed.txHash);
    if (!paying || !payee) return record(null);
    if (!route || route.kind === "none") return;
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
          record(result.txHash);
        },
        onError: (error) => setProblem(payProblem(error)),
      },
    );
  };

  const busy = send.isPending || write.isPending;
  const label = owed
    ? "Save that it was paid"
    : paying && payee
      ? `Accept and pay ${dollarsWords(usd)}`
      : "Accept the work";
  return (
    <div className="flex flex-col gap-2">
      {paying && !payee && !owed ? (
        <p className="text-sm text-muted" data-testid="task-no-payee">
          {TASK_PROBLEM.noPayee}
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
        <Button block data-testid="task-accept" disabled={busy} onClick={press}>
          {busy ? "Waiting…" : label}
        </Button>
      )}
    </div>
  );
}
