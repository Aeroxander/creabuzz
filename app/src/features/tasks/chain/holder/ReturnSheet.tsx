/**
 * Return the money of a task that ran out (plan section 5.9): anyone's press, the only call it sends. It reads the task and
 * the network's clock when it opens, says in one sentence why it cannot be pressed (early, or already settled), and asks the
 * network again right before the send. A send that may have landed is looked for before another is made. Nothing is paid:
 * the money of a task nobody was paid for goes back to the project, and everyone who took out while it was set aside can
 * claim their part.
 */
import { returnTaskCall } from "@creaton/core/pot/pot-calls.ts";
import { readTask } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import type { ProjectNumbers } from "../../../money/numbers";
import { pendingSend, sendKey } from "../../../money/pending-sends";
import { PotSheet } from "../../../pot/PotSheet";
import type { Ready } from "../../../pot/use-pot";
import { canReturn, nowOf, phaseOf } from "../state";
import { readTaskNow, stillSo, type TaskNow } from "../team/task-now";
import { ageNoteOf } from "../words";
import {
  notWaitingToReturn,
  RETURN_LOOK,
  RETURN_PRESS,
  RETURN_READ_FAILED,
  RETURN_TITLE,
  returnFacts,
  returnLine,
  returnNotYet,
  RETURNED,
} from "./holder-words";

/** The task has ended in one of the two ways a return makes (or it lapsed): the send landed or was never needed. */
const isReturned = (state: string) =>
  state === "returned" || state === "lapsed";

/** Why the money cannot be returned now, or null when it can. */
function returnBlock(read: TaskNow, now: number, windDownAt: number | null) {
  const task = read.task;
  if (task.state !== "taken")
    return notWaitingToReturn(phaseOf(task, now, windDownAt));
  return canReturn(task, now)
    ? null
    : returnNotYet(task.deadline ?? task.expiresAt);
}

export function ReturnSheet({
  numbers,
  serial,
  what,
  ready,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  serial: bigint;
  /** The team's words for the task when the plan ties to a record here, else null. */
  what: string | null;
  ready: Ready;
  open: boolean;
  onClose: () => void;
}) {
  const treasury = numbers.contracts.treasury;
  const clock = nowOf(numbers.asOf.time);
  const windDownAt = numbers.windDown?.at ?? null;
  const reading = useQuery({
    queryKey: ["pot", "return-task", treasury, String(serial), ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readTaskNow(ready, treasury, serial, clock),
  });
  const data = reading.data;
  const now = data ? Math.max(data.time, clock) : clock;
  const action = `return-task:${numbers.chainId}:${treasury}:${serial}`;
  // A send that may have landed: the task is then returned, which is the send having landed and no reason to stop the look.
  const waiting = pendingSend(sendKey(action, ready.address)) !== null;
  const landedAlready =
    waiting && data !== undefined && isReturned(data.task.state);
  const stopped =
    data && !landedAlready ? returnBlock(data, now, windDownAt) : null;
  const age = ageNoteOf(numbers, now);

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-24 animate-pulse" data-testid="return-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="return-read-failed">
        <p className="text-sm">{RETURN_READ_FAILED}</p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data)
    body = (
      <>
        <p className="text-sm" data-testid="return-words">
          {returnLine(data.task.deadline ?? data.task.expiresAt)}
        </p>
        <p className="text-sm" data-testid="return-facts">
          {returnFacts(what, data.task.setAside)}
        </p>
        {age ? (
          <p className="text-xs text-muted" data-testid="return-age">
            {age}
          </p>
        ) : null}
        {stopped ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm"
            data-testid="return-blocked"
            role="alert"
          >
            {stopped}
          </p>
        ) : null}
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={action}
      blocked={!data || stopped !== null}
      calls={data ? [returnTaskCall({ treasury, serial })] : null}
      chainId={numbers.chainId}
      confirmLabel={RETURN_PRESS}
      description="Nobody is paid. The money goes back to the project"
      detail={`${serial}`}
      done={RETURNED}
      landed={async (wallet) => {
        // A call replaced in the wallet may have landed under another hash: the task is returned.
        if (!data) return false;
        const row = await readTask(
          (to, call) => wallet.readCall(to, call),
          data.book,
          serial,
        );
        return row !== null && isReturned(row.state);
      }}
      lookLabel={RETURN_LOOK}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="return-task"
      recheck={async () => {
        // The network is asked again: the task must still be what the sheet showed, and still past its deadline.
        if (!data) return null;
        const again = await readTaskNow(ready, treasury, serial, clock);
        const stillWaiting =
          pendingSend(sendKey(action, ready.address)) !== null;
        if (stillWaiting && isReturned(again.task.state)) return null;
        const moved = stillSo({
          shown: data.task,
          fresh: again,
          waiting: false,
          result: "returned",
          windDownAt,
        });
        if (moved) return moved;
        return returnBlock(again, Math.max(again.time, clock), windDownAt);
      }}
      testId="return-sheet"
      title={RETURN_TITLE}
    >
      {/* What arrives after the sheet opened is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
