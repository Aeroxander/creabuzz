/**
 * The one sheet behind the two presses that end a task without paying anyone (plan sections 5.6 and 5.7): send the money back
 * for a taken task, withdraw a plan nobody has taken. It reads the task from the network when it opens, says in one sentence
 * why it cannot be pressed, builds the one call from that reading, and asks the network again right before the send. A send
 * that may have landed is looked for before another is made; with two people running the project the press asks the other
 * signer. Nothing is paid, and the cap on tasks is never touched here.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import { readTask, type ChainTaskNow } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import type { ProjectNumbers } from "../../../money/numbers";
import { pendingSend, sendKey } from "../../../money/pending-sends";
import type { PotAction } from "../../../money/pot-copy";
import { PotSheet } from "../../../pot/PotSheet";
import { PAIR_WORDS, runnerSend } from "../../../pot/runner-calls";
import type { Ready } from "../../../pot/use-pot";
import { nowOf } from "../state";
import type { ChainTask } from "../types";
import { readTaskNow, stillSo } from "./task-now";

/** What makes one of the two presses what it is. */
export interface StepConfig {
  /** The press's name in the money copy and the start of its action key. */
  action: Extract<PotAction, "send-back-task" | "withdraw-task">;
  testId: string;
  title: string;
  /** What the sheet is for, said before "Nothing is sent until you press". */
  description: string;
  press: string;
  pairPress: string;
  look: string;
  done: string;
  asked: string;
  /** The state the task is in once this step landed. */
  result: ChainTaskNow["state"];
  call: (treasury: string, serial: bigint) => PotCall;
  /** The one sentence that says why the press is off for a task as the network has it at `now`, or null when it may be pressed. */
  stop: (task: ChainTaskNow, now: number) => string | null;
  /** What the sheet says about the task. */
  words: (task: ChainTaskNow) => ReactNode;
}

export function TaskStepSheet({
  numbers,
  chain,
  ready,
  step,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  /** The network's row for the task, as the signed record shows it. */
  chain: ChainTask;
  ready: Ready;
  step: StepConfig;
  open: boolean;
  onClose: () => void;
}) {
  const treasury = numbers.contracts.treasury;
  const serial = chain.serial;
  const clock = nowOf(numbers.asOf.time);
  const action = `${step.action}:${numbers.chainId}:${treasury}:${serial}`;
  const reading = useQuery({
    queryKey: ["pot", step.action, treasury, String(serial), ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readTaskNow(ready, treasury, serial, clock),
  });
  const data = reading.data;
  const now = data ? Math.max(data.time, clock) : clock;
  const waiting = pendingSend(sendKey(action, ready.address)) !== null;
  // A send of this step that may have landed: the task is then in the state the step makes, which is not a reason to stop
  // the look for it (nothing new is sent while it is waiting).
  const landedAlready = waiting && data?.task.state === step.result;
  const stopped = data && !landedAlready ? step.stop(data.task, now) : null;
  const inner = data ? step.call(treasury, serial) : null;
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;

  let body: ReactNode;
  if (reading.isPending)
    body = <Card className="h-32 animate-pulse" data-testid="step-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="step-read-failed">
        <p className="text-sm">
          What this step needs could not be read from the network, so nothing
          can be sent now. Nothing changed.
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data)
    body = (
      <>
        {step.words(data.task)}
        {stopped ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm"
            data-testid="step-blocked"
            role="alert"
          >
            {stopped}
          </p>
        ) : null}
        {send?.through === "pair" ? (
          <p className="text-sm text-muted">{PAIR_WORDS}</p>
        ) : null}
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={action}
      blocked={!send || stopped !== null}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={send?.through === "pair" ? step.pairPress : step.press}
      description={step.description}
      detail={`${serial}`}
      done={send?.through === "pair" ? step.asked : step.done}
      landed={async (wallet) => {
        // A call replaced in the wallet may have landed under another hash: the task is in the state the step makes.
        if (!data) return false;
        const row = await readTask(
          (to, call) => wallet.readCall(to, call),
          data.book,
          serial,
        );
        return row?.state === step.result;
      }}
      lookLabel={step.look}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction={step.action}
      recheck={async () => {
        // The network is asked again: the task must still be what the sheet showed, and the step still possible.
        if (!data) return null;
        const fresh = await readTaskNow(ready, treasury, serial, clock);
        const stillWaiting =
          pendingSend(sendKey(action, ready.address)) !== null;
        const moved = stillSo({
          shown: data.task,
          fresh,
          waiting: stillWaiting,
          result: step.result,
          windDownAt: numbers.windDown?.at ?? null,
        });
        if (moved) return moved;
        if (stillWaiting && fresh.task.state === step.result) return null;
        return step.stop(fresh.task, Math.max(fresh.time, clock));
      }}
      testId={step.testId}
      title={step.title}
    >
      {/* What arrives after the sheet opened is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
