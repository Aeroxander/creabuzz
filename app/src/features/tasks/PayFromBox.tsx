import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { boxOf } from "@creaton/core/pot/pot-state.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { allowancePerDay, type ProjectNumbers } from "../money/numbers";
import { asRunner, runnerRole } from "../money/runner";
import { useMoneySend, useWallet } from "../money/use-money";
import { PAIR_WORDS } from "../pot/runner-calls";
import { readPairWaiting } from "../pot/use-pair-waiting";
import { boxNow, PLAY_MONEY_WORDS } from "../pot/pot-words";
import type { Project } from "../project/project-record";
import {
  forgetPaid,
  paidElsewhere,
  paidNotRecorded,
  rememberPaid,
} from "./paid-journal";
import { findPayment } from "./pay-lookup";
import { drawForTaskCall, rawDollars } from "./task-calls";
import { type ProjectTask, payRecord } from "./task-record";
import {
  boxShortWords,
  dollarsWords,
  foundWords,
  payProblem,
  payTermsWords,
  TASK_PROBLEM,
} from "./tasks-copy";
import { freshTask, useTaskWrite } from "./use-tasks";

/** Whether the task, read fresh, is still the accepted, unpaid one the press was about to pay. */
function stillOwed(
  now: ProjectTask | null,
  task: ProjectTask,
  payee: string,
): boolean {
  return (
    now !== null &&
    now.state === "accepted" &&
    now.paidTx === null &&
    now.handIn?.id === task.handIn?.id &&
    now.worker === task.worker &&
    now.payTo === payee
  );
}

/**
 * Pay an accepted task whose pay is still owed, out of the allowance box. It is the other half of "accept now, pay later":
 * the runner's own wallet draws the pay to the wallet the worker named, and the payment's transaction is then written on the
 * task, so a task's pay is always linked to the task. Before anything moves the task and the box are read again, and the
 * chain is searched for a payment of exactly this pay already made after the acceptance (a Pair's second signer confirmed it,
 * another device paid it): such a payment is offered as this task's pay, never paid twice. A payment that landed without its
 * record is kept (`paid-journal.ts`) and the next press only writes the record. With a Pair as runner the press asks the
 * other signer, whose confirmation is named for this task on the Money tab; once it has run, the payment is found here and
 * saved. Never the server, never an agent.
 */
export function PayFromBox({
  project,
  task,
  numbers,
  address,
  taken,
}: {
  project: Project;
  task: ProjectTask;
  numbers: ProjectNumbers;
  address: string | null;
  /** Payments already recorded on this project's other tasks: they are never offered for this one. */
  taken: ReadonlySet<string>;
}) {
  const write = useTaskWrite(project);
  const send = useMoneySend(`task-pay:${task.id}`);
  const toast = useToast();
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const [problem, setProblem] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [asked, setAsked] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const piece = task.handIn?.id ?? null;
  const usd = task.usd ?? 0;
  const payee = task.payTo;
  const treasury = numbers.contracts.treasury;
  const role = runnerRole(numbers, address);
  const owed = paidNotRecorded(task.id);
  const raw = rawDollars(usd);
  const readBox = () =>
    boxOf((to, data) => wallet.readCall(to, data), treasury);
  const lookFor = () =>
    findPayment(
      wallet,
      treasury,
      payee ?? "",
      raw,
      task.acceptedAt ?? 0,
      new Set([...taken, ...paidElsewhere(task.id)]),
    );
  const onChain = useQuery({
    queryKey: ["pot", "task-box", treasury],
    enabled: role.kind !== "none" && !owed && piece !== null,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: readBox,
  });
  const found = useQuery({
    queryKey: ["pot", "task-pay-found", task.id, treasury, payee],
    enabled: role.kind !== "none" && !owed && Boolean(payee) && piece !== null,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: lookFor,
  });
  if (piece === null) return null;
  const box = boxNow(numbers, onChain.data ?? 0n);
  const perDay = allowancePerDay(numbers);
  const offered = found.data && !elsewhere ? found.data : null;

  const record = (txHash: string, forPiece: string) =>
    write.mutate(
      {
        record: payRecord(project.coordinate, task, forPiece, txHash),
        failure: TASK_PROBLEM.recordAfterPay,
      },
      {
        onSuccess: () => {
          forgetPaid(task.id);
          toast(`Paid ${dollarsWords(usd)}.`, "done");
        },
        onError: () => setProblem(TASK_PROBLEM.recordAfterPay),
      },
    );
  /** A payment found on the chain, or one whose record failed: remembered first, so the record is retried and never paid twice. */
  const save = (txHash: string, forPiece: string) => {
    setProblem(null);
    rememberPaid({
      task: task.id,
      handIn: forPiece,
      txHash,
      at: Math.floor(Date.now() / 1000),
    });
    record(txHash, forPiece);
  };

  const press = async () => {
    setProblem(null);
    if (!payee || role.kind === "none") return;
    setLooking(true);
    const now = await freshTask(queryClient, project, task.id);
    const have = await readBox().catch(() => null);
    // A search that cannot be read is not "nothing found": the press stops, as the sheets' own re-check does.
    let hit: Awaited<ReturnType<typeof lookFor>> = null;
    let searched = true;
    if (!elsewhere) {
      try {
        hit = await lookFor();
      } catch {
        searched = false;
      }
    }
    setLooking(false);
    if (!stillOwed(now, task, payee)) return setProblem(TASK_PROBLEM.changed);
    if (!searched) {
      void found.refetch();
      return setProblem(TASK_PROBLEM.searchShort);
    }
    if (hit) {
      void found.refetch();
      return setProblem(TASK_PROBLEM.alreadyLeft);
    }
    const holds = boxNow(numbers, have ?? 0n);
    if (raw > holds)
      return setProblem(
        boxShortWords(holds, perDay, "Pay it when the box holds enough."),
      );
    const sent = asRunner(
      numbers,
      address,
      drawForTaskCall(treasury, payee, usd),
    );
    if (!sent) return;
    if (sent.through === "pair") {
      // The same pay already asked of the other signer (a reload lost this page's memory of it, or they asked from their own
      // page) is never asked twice: confirming both would pay it twice.
      let waiting: Awaited<ReturnType<typeof readPairWaiting>>;
      setLooking(true);
      try {
        waiting = await readPairWaiting(
          {
            address: address ?? "",
            wallet,
            read: (to, data) => wallet.readCall(to, data),
          },
          sent.call.to,
        );
      } catch {
        setLooking(false);
        return setProblem(TASK_PROBLEM.askedUnknown);
      }
      setLooking(false);
      const inner = drawForTaskCall(treasury, payee, usd);
      if (
        waiting.waiting.some(
          (w) =>
            w.target === inner.to.toLowerCase() &&
            w.data === inner.data.toLowerCase(),
        )
      ) {
        setAsked(true);
        return setProblem(TASK_PROBLEM.alreadyAsked);
      }
    }
    send.send(
      {
        chainId: numbers.chainId,
        detail: task.id.slice(0, 16),
        build: () => [sent.call],
      },
      {
        onSuccess: (result) => {
          if (sent.through === "pair") {
            setAsked(true);
            toast(TASK_PROBLEM.asked, "done");
            return;
          }
          save(result.txHash, piece);
        },
        onError: (error) => setProblem(payProblem(error)),
      },
    );
  };

  const busy = send.isPending || write.isPending || looking;
  const pairRuns = role.kind === "signer";
  let body: ReactNode;
  if (!payee) {
    body = (
      <p className="text-sm text-muted" data-testid="task-pay-no-payee">
        {TASK_PROBLEM.owedNoPayee}
      </p>
    );
  } else if (numbers.windDown) {
    body = (
      <p className="text-sm text-muted" data-testid="task-pay-wound-down">
        {TASK_PROBLEM.woundDown}
      </p>
    );
  } else if (role.kind === "none") {
    body = (
      <p className="text-sm text-muted" data-testid="task-pay-not-runner">
        {TASK_PROBLEM.notRunner}
      </p>
    );
  } else if (owed) {
    body = (
      <>
        <p className="text-sm" data-testid="task-pay-owed-record">
          {TASK_PROBLEM.recordAfterPay}
        </p>
        <Button
          block
          data-testid="task-pay-save"
          disabled={busy}
          onClick={() => {
            setProblem(null);
            record(owed.txHash, owed.handIn);
          }}
        >
          {busy ? "Waiting…" : "Save that it was paid"}
        </Button>
      </>
    );
  } else if (offered) {
    body = (
      <>
        <p className="text-sm" data-testid="task-pay-found">
          {foundWords(usd, payee, offered.at)}
        </p>
        <Button
          block
          data-testid="task-pay-save"
          disabled={busy}
          onClick={() => save(offered.txHash, piece)}
        >
          {busy ? "Waiting…" : "Save that it was paid"}
        </Button>
        <Button
          data-testid="task-pay-elsewhere"
          onClick={() => setElsewhere(true)}
          size="sm"
          variant="ghost"
        >
          That was for something else
        </Button>
      </>
    );
  } else if (found.isError && !elsewhere) {
    // Whether it was paid before cannot be told: no bare "Pay from the box" is offered until a search can be read.
    body = (
      <>
        <p className="text-sm" data-testid="task-pay-search-short">
          {TASK_PROBLEM.searchShort}
        </p>
        <Button
          block
          data-testid="task-pay-look-again"
          disabled={found.isFetching}
          onClick={() => void found.refetch()}
          variant="secondary"
        >
          {found.isFetching ? "Looking…" : "Look again"}
        </Button>
      </>
    );
  } else if (raw > box) {
    body = (
      <p className="text-sm text-muted" data-testid="task-pay-box-short">
        {boxShortWords(box, perDay, "Pay it when the box holds enough.")}
      </p>
    );
  } else if (asked) {
    body = (
      <p className="text-sm" data-testid="task-pay-asked">
        {TASK_PROBLEM.asked}
      </p>
    );
  } else {
    body = (
      <>
        <p className="text-sm" data-testid="task-pay-terms">
          {payTermsWords(usd, payee)}
        </p>
        {pairRuns ? <p className="text-sm text-muted">{PAIR_WORDS}</p> : null}
        <Button
          block
          data-testid="task-pay"
          disabled={busy}
          onClick={() => void press()}
        >
          {busy
            ? "Waiting…"
            : pairRuns
              ? "Ask for the pay from the box"
              : "Pay from the box"}
        </Button>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="task-pay-section">
      {mustSayPlayMoney(numbers.playMoney) ? (
        <p className="text-sm text-muted" data-testid="task-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
      {body}
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="task-pay-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
