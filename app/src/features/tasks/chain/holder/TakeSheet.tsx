/**
 * The Take sheet (plan section 5.8): the person a plan is named for sets the money aside. It reads the network when it
 * opens, shows what taking sets aside and the guard on it (checked: nothing is taken unless the whole most would be), and
 * sends that one call and nothing else, from the person's own account. The network is asked again right before the send, and
 * a send that may have landed is looked for before another is made. Nothing is written to the team's record: the chain is
 * the take.
 */
import { takeTaskCall } from "@creaton/core/pot/pot-calls.ts";
import { readTask } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import { useToast } from "../../../../ui/toast";
import type { ProjectNumbers } from "../../../money/numbers";
import { pendingSend, sendKey } from "../../../money/pending-sends";
import { PotSheet } from "../../../pot/PotSheet";
import type { Ready } from "../../../pot/use-pot";
import { nowOf } from "../state";
import { stillSo } from "../team/task-now";
import { SheetLine } from "../team/SheetLine";
import type { ChainTasks } from "../types";
import { ageNoteOf, dollarsPhrase, percentOfBps } from "../words";
import {
  namedLine,
  TAKE_LOOK,
  TAKE_PRESS,
  TAKE_READ_FAILED,
  TAKEN,
  takeAmountLine,
  takeDueLine,
  takeGuard,
  takeGuardHint,
  takenWords,
  takeShort,
  takeTitle,
} from "./holder-words";
import { atMostOf, takeBlock } from "./take-gate";
import { readTake } from "./take-read";

const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export function TakeSheet({
  numbers,
  queue,
  serial,
  what,
  ready,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  queue: ChainTasks;
  serial: bigint;
  /** The team's words for the task when the plan ties to a record here, else null. */
  what: string | null;
  ready: Ready;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const treasury = numbers.contracts.treasury;
  const clock = nowOf(numbers.asOf.time);
  const [whole, setWhole] = useState(true);
  const reading = useQuery({
    queryKey: ["pot", "take-task", treasury, String(serial), ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readTake(ready, treasury, serial, clock),
  });
  const data = reading.data;
  const now = data ? Math.max(data.time, clock) : clock;
  const task = data?.task ?? null;
  const action = `take-task:${numbers.chainId}:${treasury}:${serial}`;
  // A send of this step that may have landed: the task is then taken by this account, which is the send having landed and
  // not a reason to stop the look for it (nothing new is sent while it is waiting).
  const waiting = pendingSend(sendKey(action, ready.address)) !== null;
  const landedAlready =
    waiting && task?.state === "taken" && same(task.takenBy, ready.address);
  const stopped =
    data && !landedAlready
      ? takeBlock({ read: data, numbers, queue, address: ready.address, now })
      : null;
  const minAmount = task
    ? whole
      ? task.maxDollars
      : queue.limits.minTask
    : 0n;
  const call =
    task && minAmount > 0n
      ? takeTaskCall({ treasury, serial, minAmount })
      : null;
  const atMost = task
    ? atMostOf(task.maxDollars, task.shareBps, numbers.money.pot)
    : 0n;
  const age = ageNoteOf(numbers, now);
  const detail = task ? `${serial}:${minAmount}` : undefined;

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-40 animate-pulse" data-testid="take-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="take-read-failed">
        <p className="text-sm">{TAKE_READ_FAILED}</p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (task)
    body = (
      <>
        <p className="text-sm font-semibold" data-testid="take-named">
          {namedLine(task.maxDollars)}
        </p>
        <dl className="divide-y divide-white/10">
          <SheetLine label="Set aside now, about" testId="take-at-most">
            {dollarsPhrase(atMost)}
          </SheetLine>
        </dl>
        <p className="text-sm" data-testid="take-amount">
          {takeAmountLine({
            max: task.maxDollars,
            share: percentOfBps(task.shareBps),
            atMost,
          })}
        </p>
        {age ? (
          <p className="text-xs text-muted" data-testid="take-age">
            {age}
          </p>
        ) : null}
        <p className="text-sm" data-testid="take-due">
          {takeDueLine(queue.limits.dueSecs)}
        </p>
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm">
            <input
              aria-describedby="take-guard-hint"
              checked={whole}
              className="mt-0.5 size-5 shrink-0 accent-current"
              data-testid="take-guard"
              onChange={(event) => setWhole(event.target.checked)}
              type="checkbox"
            />
            <span>{takeGuard(task.maxDollars)}</span>
          </label>
          <p
            className="text-sm text-muted"
            data-testid="take-guard-hint"
            id="take-guard-hint"
          >
            {takeGuardHint(whole, queue.limits.minTask)}
          </p>
        </div>
        {whole && atMost < task.maxDollars ? (
          <p className="text-sm" data-testid="take-short">
            {takeShort(atMost, task.maxDollars)}
          </p>
        ) : null}
        {stopped ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm"
            data-testid="take-blocked"
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
      blocked={!call || stopped !== null}
      calls={call ? [call] : null}
      chainId={numbers.chainId}
      confirmLabel={TAKE_PRESS}
      description="Taking sets the money aside for you"
      detail={detail}
      done={TAKEN}
      landed={async (wallet) => {
        // A call replaced in the wallet may have landed under another hash: the task is taken.
        if (!data) return false;
        const row = await readTask(
          (to, call) => wallet.readCall(to, call),
          data.book,
          serial,
        );
        // Only the wallet the plan names can take it, and the sheet is only open for that wallet: a task found taken is the step.
        return row?.state === "taken";
      }}
      lookLabel={TAKE_LOOK}
      onLanded={(_txHash, landed) => {
        // Said again with the network's own numbers; an earlier press that was only looked up is not this one.
        if (landed !== detail || !data) return;
        void (async () => {
          try {
            const row = await readTask(ready.read, data.book, serial);
            if (row && row.deadline !== null)
              toast(takenWords(row.setAside, row.deadline), "done");
          } catch {
            // The figures are a courtesy; the task is taken either way.
          }
        })();
      }}
      onOpenChange={(next) => {
        if (!next) {
          setWhole(true);
          onClose();
        }
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="take-task"
      recheck={async () => {
        // The network is asked again: the task must still be what the sheet showed, and still takeable.
        if (!data) return null;
        const again = await readTake(ready, treasury, serial, clock);
        const stillWaiting =
          pendingSend(sendKey(action, ready.address)) !== null;
        if (
          stillWaiting &&
          again.task.state === "taken" &&
          same(again.task.takenBy, ready.address)
        )
          return null;
        const moved = stillSo({
          shown: data.task,
          fresh: again,
          waiting: stillWaiting,
          result: "taken",
          windDownAt: numbers.windDown?.at ?? null,
        });
        if (moved) return moved;
        return takeBlock({
          read: again,
          numbers,
          queue,
          address: ready.address,
          now: Math.max(again.time, clock),
        });
      }}
      testId="take-sheet"
      title={takeTitle(what)}
    >
      {/* What arrives after the sheet opened is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
