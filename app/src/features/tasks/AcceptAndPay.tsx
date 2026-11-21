import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { boxOf } from "@creaton/core/pot/pot-state.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import {
  allowancePerDay,
  isRunner,
  type ProjectNumbers,
} from "../money/numbers";
import { useMoneySend, useWallet } from "../money/use-money";
import { PLAY_MONEY_WORDS, boxNow } from "../pot/pot-words";
import { planOfRecord } from "./chain/team/plan-read";
import { PAID_RETRY } from "./chain/team/pay-words";
import type { Project } from "../project/project-record";
import { forgetPaid, paidNotRecorded, rememberPaid } from "./paid-journal";
import { drawForTaskCall, rawDollars } from "./task-calls";
import { acceptRecord, type ProjectTask } from "./task-record";
import {
  boxShortWords,
  dollarsWords,
  payProblem,
  recordProblem,
  TASK_PROBLEM,
  pressName,
} from "./tasks-copy";
import { freshTask, useTaskWrite } from "./use-tasks";

/** How the work's payment can be sent from the wallet this site sees, or why it cannot. */
export type PayRoute =
  | { kind: "treasury"; treasury: string; chainId: number }
  | { kind: "none"; why: string };

/**
 * Who pays and how: the runner's own wallet draws the pay from the allowance box (`Treasury.draw`), and only while the
 * box holds enough. `box` is the most the record and the chain's own reading say it holds (a draw by someone else lowers
 * it, so it is never taken from the record alone, and the chain has the last word when the draw is sent). A project run by
 * two people needs both to sign a draw, which is not one press: it is not offered here. Never the server, never an agent.
 */
function payRoute(
  numbers: ProjectNumbers | null,
  address: string | null,
  usd: number,
  box: bigint,
): PayRoute {
  if (!numbers) return { kind: "none", why: TASK_PROBLEM.notRunner };
  if (numbers.runner.isPair)
    return { kind: "none", why: TASK_PROBLEM.pairNeedsBoth };
  if (!isRunner(numbers, address))
    return { kind: "none", why: TASK_PROBLEM.notRunner };
  if (rawDollars(usd) > box)
    return {
      kind: "none",
      why: boxShortWords(box, allowancePerDay(numbers)),
    };
  return {
    kind: "treasury",
    treasury: numbers.contracts.treasury,
    chainId: numbers.chainId,
  };
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
 * Accept handed-in work and pay for it out of the allowance box: one press. The task is read again first and the press stops if it has moved
 * (someone gave it up, handed in again, cancelled it): money sent for a record the server then refuses cannot be taken
 * back. The money goes next, from the wallet; the record that the work was accepted names its transaction and goes
 * last. A payment whose record failed is remembered (`paid-journal.ts`), so the next press writes the record, for the
 * piece that was paid for, and never pays again. With money off the press only accepts the work. A task that pays but
 * whose taker named no wallet cannot be paid: accepting it is a second, plainly worded choice (two presses), never the
 * ordinary button. Work accepted without its pay shows to everyone as "accepted, pay owed", and the task then offers
 * "Pay from the box" (`PayFromBox`) as soon as the box holds enough, which links the payment to the task.
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
  const wallet = useWallet();
  const handIn = task.handIn;
  const owed = handIn ? paidNotRecorded(task.id) : null;
  const usd = task.usd ?? 0;
  const paying = numbers !== null && usd > 0;
  const treasury = numbers?.contracts.treasury ?? "";
  const readBox = () =>
    boxOf((to, data) => wallet.readCall(to, data), treasury);
  // The box as the chain keeps it, for the gate: where it cannot be read the record's own figure stands.
  const onChain = useQuery({
    queryKey: ["pot", "task-box", treasury],
    enabled: paying && !owed && Boolean(handIn) && treasury !== "",
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: readBox,
  });
  if (!handIn) return null;
  const route =
    paying && numbers
      ? payRoute(numbers, address, usd, boxNow(numbers, onChain.data ?? 0n))
      : null;
  const payee = task.payTo;
  const blocked =
    paying && !owed ? (route?.kind === "none" ? route.why : null) : null;
  // A project run by two people, or a box too short now, still has a way forward: accept the work without paying here
  // (two presses, said plainly), and pay from the Money tab. Only a wallet that is not the runner's has no press at all.
  const payLater =
    paying &&
    !owed &&
    route?.kind === "none" &&
    numbers !== null &&
    (numbers.runner.isPair || isRunner(numbers, address));

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
              : paying
                ? `Work accepted. The pay is still owed: ${dollarsWords(usd)}.`
                : "Work accepted.",
            "done",
          );
        },
        onError: (error) =>
          setProblem(txHash ? recordProblem(error, PAID_RETRY) : error.message),
      },
    );

  const press = async () => {
    setProblem(null);
    // The payment's record goes against the piece that was paid for, even if newer work was handed in since.
    if (owed) return record(owed.txHash, owed.handIn);
    if (!paying) return record(null, handIn.id);
    if (!payee || payLater) {
      if (!sure) return setSure(true);
      return record(null, handIn.id);
    }
    if (!route || route.kind === "none" || !numbers) return;
    setLooking(true);
    const now = await freshTask(queryClient, project, task.id);
    // The box is read again as the chain has it now (a draw by someone else since the page was drawn lowers it).
    const fresh = await readBox().catch(() => null);
    // One door: a task a plan stands on is paid there. The signed record can be older than the plan, so the chain is asked.
    let planned: Awaited<ReturnType<typeof planOfRecord>> = null;
    let unknown = false;
    try {
      planned = await planOfRecord(
        (to, data) => wallet.readCall(to, data),
        treasury,
        task.id,
        Math.floor(Date.now() / 1000),
        wallet.blockTime?.bind(wallet),
      );
    } catch {
      unknown = true;
    }
    setLooking(false);
    if (moved(now, task, handIn.id, payee))
      return setProblem(TASK_PROBLEM.changed);
    if (unknown) return setProblem(TASK_PROBLEM.planUnknown);
    if (planned) return setProblem(TASK_PROBLEM.plannedOnNetwork);
    const have = boxNow(numbers, fresh ?? 0n);
    if (rawDollars(usd) > have)
      return setProblem(boxShortWords(have, allowancePerDay(numbers)));
    send.send(
      {
        chainId: route.chainId,
        detail: task.id.slice(0, 16),
        build: () => [drawForTaskCall(route.treasury, payee, usd)],
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
  const unpaid = paying && !owed && (!payee || payLater);
  const label = owed
    ? "Save that it was paid"
    : unpaid
      ? sure
        ? "Yes, accept it and pay later"
        : `Accept now, pay ${dollarsWords(usd)} later`
      : paying
        ? `Accept and pay ${dollarsWords(usd)}`
        : "Accept the work";
  return (
    <div className="flex flex-col gap-2">
      {paying && numbers && mustSayPlayMoney(numbers.playMoney) ? (
        <p className="text-sm text-muted" data-testid="task-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
      {unpaid && !payee ? (
        <p className="text-sm text-muted" data-testid="task-no-payee">
          {sure ? TASK_PROBLEM.noPayeeSure : TASK_PROBLEM.noPayee}
        </p>
      ) : null}
      {unpaid && payee && sure ? (
        <p className="text-sm text-muted" data-testid="task-pay-later">
          {numbers?.runner.isPair
            ? TASK_PROBLEM.pairSure
            : TASK_PROBLEM.boxShortSure}
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
      {blocked && payee && !payLater ? null : (
        <Button
          block
          data-testid="task-accept"
          aria-label={pressName(busy ? "Waiting…" : label, task.what)}
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
