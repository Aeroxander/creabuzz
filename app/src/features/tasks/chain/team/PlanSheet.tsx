/**
 * The Plan sheet (plan section 5.2): the team plans the pay of one task, so holders get notice before any money moves. It
 * reads the network when it opens, shows exactly what the one call will say (who is paid, the most, the share of the
 * project's money, the notice and the dates), and sends that call and nothing else. Nothing moves when it is pressed: the
 * worker takes the task later, after the notice, and only then is money set aside.
 *
 * One press is one signature (with two people running the project, one proposal for the other signer). The numbers the
 * press is built from are the numbers on the sheet; the network is asked again right before the send, and a send that may
 * have landed is looked for before another is made.
 */
import { announceTaskCall } from "@creaton/core/pot/pot-calls.ts";
import { readTask } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import { useToast } from "../../../../ui/toast";
import type { ProjectNumbers } from "../../../money/numbers";
import { pendingSend, sendKey } from "../../../money/pending-sends";
import { PotSheet } from "../../../pot/PotSheet";
import { PAIR_WORDS, runnerSend } from "../../../pot/runner-calls";
import type { Ready } from "../../../pot/use-pot";
import type { ProjectTask } from "../../task-record";
import { doorFor, shareFor } from "../door";
import { nowOf, openCountAt } from "../state";
import type { ChainTasks } from "../types";
import { dollarsPhrase } from "../words";
import { planBlock } from "./plan-gate";
import { SheetLine } from "./SheetLine";
import {
  LOOK_SERIALS,
  plannedAlready,
  plannedSince,
  readPlan,
} from "./plan-read";
import {
  checkInLine,
  detailsLine,
  dueLine,
  lapseLine,
  noticeLine,
  PLAN_ASKED,
  PLAN_BLOCK,
  PLAN_LOOK,
  PLAN_MOVED,
  PLAN_PRESS,
  PLAN_PRESS_PAIR,
  PLAN_READ_FAILED,
  PLANNED,
  plannedWords,
  planTitle,
  shareLine,
  alreadyPlanned,
} from "./plan-words";

const DOLLAR = 1_000_000n;

export function PlanSheet({
  numbers,
  queue,
  task,
  ready,
  workerName,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  queue: ChainTasks;
  task: ProjectTask;
  ready: Ready;
  /** The worker's name, as the card shows it. */
  workerName: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const treasury = numbers.contracts.treasury;
  const usd = task.usd;
  const pay = BigInt(usd ?? 0) * DOLLAR;
  const share =
    usd === null
      ? null
      : shareFor(pay, numbers.money.pot, queue.limits.maxShareBps);
  const what = `0x${task.id.toLowerCase()}`;
  const clock = nowOf(numbers.asOf.time);
  // Everything a plan stands on that can move is read when the sheet opens, past any cache.
  const reading = useQuery({
    queryKey: ["pot", "plan", treasury, task.id, share, ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readPlan(ready, treasury, share, clock),
  });
  const data = reading.data;
  const door = data
    ? doorFor({
        usd: usd ?? 0,
        box: data.box,
        boxCap: data.boxCap,
        pot: numbers.money.pot,
        payee: task.payTo,
        runner: numbers.runner,
        limits: queue.limits,
        notice: data.notice,
      })
    : null;
  const block =
    data && door
      ? planBlock({
          numbers,
          queue,
          task,
          read: data,
          share,
          door,
          address: ready.address,
          now: clock,
          workerName,
        })
      : null;
  // The call is built from the numbers on the sheet whenever they make one; whether it may be pressed is the block's say.
  let inner = null;
  if (data && share !== null && task.payTo) {
    try {
      inner = announceTaskCall({
        treasury,
        what,
        payee: task.payTo,
        maxDollars: pay,
        shareBps: share,
      });
    } catch {
      inner = null;
    }
  }
  const action = `plan-task:${numbers.chainId}:${treasury}:${what}`;
  // A send of this plan that may have landed: the press then looks for it first, and "this task is already planned" is what
  // finding it looks like, so that one block never stands in the way of the look (nothing new is sent while it is waiting).
  const waiting = pendingSend(sendKey(action, ready.address)) !== null;
  const stops = block && !(block.why === "planned" && waiting) ? block : null;
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;
  const from = data?.notice ? data.time + data.notice.noticeSecs : null;
  const until =
    from !== null && data?.notice ? from + data.notice.takeWindowSecs : null;
  const checkLine =
    data && from !== null && until !== null
      ? checkInLine({ activeEnd: data.activeEnd, from, until })
      : null;
  const needBps =
    numbers.money.pot > 0n
      ? Number((pay * 10_000n + numbers.money.pot - 1n) / numbers.money.pot)
      : 0;
  const detail = data ? `${what.slice(2, 18)}:${data.nextSerial}` : undefined;

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-40 animate-pulse" data-testid="plan-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="plan-read-failed">
        <p className="text-sm">{PLAN_READ_FAILED}</p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data && door)
    body = (
      <>
        <dl className="divide-y divide-white/10">
          <SheetLine label="Pay to" testId="plan-pay-to">
            {workerName}
            <span className="num block text-sm text-muted">
              {task.payTo ?? "no wallet named"}
            </span>
          </SheetLine>
          <SheetLine label="Up to" testId="plan-max">
            {dollarsPhrase(pay)}
            {share !== null ? (
              <span
                className="block text-sm text-muted"
                data-testid="plan-share"
              >
                {shareLine(share)}
              </span>
            ) : null}
          </SheetLine>
        </dl>
        {data.notice && from !== null && until !== null ? (
          <div className="flex flex-col gap-1 text-sm" data-testid="plan-dates">
            <p data-testid="plan-notice">
              {noticeLine(data.notice.noticeSecs, from)}
            </p>
            <p data-testid="plan-lapse">
              {lapseLine(data.notice.takeWindowSecs)}
            </p>
            <p data-testid="plan-due">{dueLine(data.notice.dueSecs)}</p>
            {checkLine ? <p data-testid="plan-checkin">{checkLine}</p> : null}
          </div>
        ) : null}
        {share !== null ? (
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer font-semibold">
              Details
            </summary>
            <p className="mt-1 text-muted" data-testid="plan-details">
              {detailsLine({
                shareBps: share,
                roomBps: queue.cap.roomBps,
                needBps,
                roomBackAt: queue.cap.frees[0]?.at ?? null,
              })}
            </p>
          </details>
        ) : null}
        <p className="text-sm" data-testid="plan-door">
          {door.sentence}
        </p>
        {block ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm"
            data-testid="plan-blocked"
            role="alert"
          >
            {block.sentence}
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
      blocked={!send || stops !== null}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={send?.through === "pair" ? PLAN_PRESS_PAIR : PLAN_PRESS}
      description="Nothing moves yet. Holders get notice first"
      detail={detail}
      done={send?.through === "pair" ? PLAN_ASKED : PLANNED}
      landed={(wallet, _from, earlier) =>
        // A call replaced in the wallet may have landed under another hash: a newer serial with this task's id says so.
        plannedSince(
          (to, data) => wallet.readCall(to, data),
          treasury,
          what,
          (earlier.detail ?? "").split(":")[1],
        )
      }
      lookLabel={PLAN_LOOK}
      onLanded={(_txHash, landed) => {
        // Said again with the chain's own date; a plan asked of the other signer has no date yet, and an earlier press that
        // was only looked up is not this one.
        if (send?.through === "pair" || landed !== detail || !data) return;
        void (async () => {
          try {
            for (
              let s = data.nextSerial;
              s < data.nextSerial + BigInt(LOOK_SERIALS);
              s += 1n
            ) {
              const row = await readTask(ready.read, data.book, s);
              if (row === null) return;
              if (row.what === what) {
                toast(plannedWords(row.noticeEnd), "done");
                return;
              }
            }
          } catch {
            // The date is a courtesy; the plan has landed either way.
          }
        })();
      }}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="plan-task"
      recheck={async () => {
        // The network is asked again: what the sheet showed must still be so, or nothing is sent.
        const again = await readPlan(ready, treasury, share, clock);
        const same = plannedAlready(again, task.id);
        // A plan found while a send of this one is waiting is that send: the press then looks it up and sends nothing.
        if (same)
          return pendingSend(sendKey(action, ready.address)) !== null
            ? null
            : alreadyPlanned(same.noticeEnd);
        if (again.activeEnd <= again.time) return PLAN_BLOCK.quiet;
        if (openCountAt(again.open, again.time) >= queue.limits.maxOpen)
          return PLAN_BLOCK.full;
        const was = data?.notice;
        const now = again.notice;
        if (
          was &&
          now &&
          (was.noticeSecs !== now.noticeSecs ||
            was.takeWindowSecs !== now.takeWindowSecs ||
            was.dueSecs !== now.dueSecs)
        )
          return PLAN_MOVED;
        return null;
      }}
      testId="plan-sheet"
      title={planTitle(task.what)}
    >
      {/* What arrives after the sheet opened is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
