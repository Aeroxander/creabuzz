/**
 * The Accept sheet (plan section 5.5): the team pays for handed-in work, in full or in part, out of the money the network
 * set aside for the task. The task is read from the network when the sheet opens (never from the record): the one sentence
 * of `acceptGate` is shown when it cannot be paid, and the press is built from the chain's own numbers. The money goes to the
 * wallet that took the task on the network and to nobody else (the call has no recipient).
 *
 * One press is one signature (with two people running the project, one proposal for the other signer). The network is asked
 * again right before the send, and a send that may have landed is looked for before another is made. Once the payment landed
 * the team's record is written from the transaction the network gives for this task's number.
 */
import { acceptTaskCall } from "@creaton/core/pot/pot-calls.ts";
import { readTask } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import { Field } from "../../../../ui/field";
import type { ProjectNumbers } from "../../../money/numbers";
import { pendingSend, sendKey } from "../../../money/pending-sends";
import { PotSheet } from "../../../pot/PotSheet";
import { PAIR_WORDS, runnerSend } from "../../../pot/runner-calls";
import type { Ready } from "../../../pot/use-pot";
import type { ProjectTask, WorkerLinks } from "../../task-record";
import { acceptGate, nowOf } from "../state";
import type { ChainTask } from "../types";
import { partPay } from "./amount";
import {
  exactPhrase,
  goesBack,
  PAY_ASKED,
  PAY_CHOICE,
  PAY_DETAILS,
  PAY_FIXED_LEFT,
  PAY_LOOK,
  PAY_PART,
  PAY_PART_LABEL,
  PAY_PRESS_PAIR,
  PAY_READ_FAILED,
  SAVE_PAID,
  paidDone,
  payAll,
  payPress,
  payTitle,
  setAsideLine,
} from "./pay-words";
import { SheetLine } from "./SheetLine";
import { readTaskNow, stillSo } from "./task-now";
import { recordOwed } from "./use-save-paid";

type Choice = "all" | "part";

export function AcceptSheet({
  numbers,
  task,
  chain,
  ready,
  workerName,
  me,
  team,
  links,
  open,
  onClose,
  onSendBack,
  onPaid,
}: {
  numbers: ProjectNumbers;
  /** The team's task record. */
  task: ProjectTask;
  /** The network's row for it, as the signed record shows it (its fresh reading is what the press stands on). */
  chain: ChainTask;
  ready: Ready;
  workerName: string;
  /** The signed-in account's key (whose own work it may not be). */
  me: string;
  team: ReadonlySet<string>;
  links: WorkerLinks;
  open: boolean;
  onClose: () => void;
  /** Offered beside the sentence when the money can still be sent back instead. */
  onSendBack: () => void;
  /** Runs once the payment landed (the team's record is written there). */
  onPaid: () => void;
}) {
  const treasury = numbers.contracts.treasury;
  const serial = chain.serial;
  const clock = nowOf(numbers.asOf.time);
  const action = `pay-task:${numbers.chainId}:${treasury}:${serial}`;
  const [choice, setChoice] = useState<Choice>("all");
  const [typed, setTyped] = useState("");
  const reading = useQuery({
    queryKey: ["pot", "accept", treasury, String(serial), ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readTaskNow(ready, treasury, serial, clock),
  });
  const data = reading.data;
  // The chain's clock, but never behind what the record says the time is.
  const now = data ? Math.max(data.time, clock) : clock;
  const gateOf = (fresh: NonNullable<typeof data>["task"], at: number) =>
    acceptGate({
      fresh,
      shown: chain,
      relay: task,
      now: at,
      me,
      address: ready.address,
      runner: numbers.runner,
      team,
      links,
    });
  const gate = data ? gateOf(data.task, now) : null;
  const waiting = pendingSend(sendKey(action, ready.address)) !== null;
  // A send of this payment that may have landed: "not waiting for payment" is that send having landed, so it never stands in
  // the way of the look for it (nothing new is sent while it is waiting).
  const landedAlready = waiting && data?.task.state === "paid";
  const stops = gate && !gate.ok && !landedAlready ? gate : null;

  const setAside = data?.task.setAside ?? 0n;
  const part = choice === "part" ? partPay(typed, setAside) : null;
  const pay = choice === "all" ? setAside : part?.ok ? part.raw : null;
  let inner = null;
  if (data && pay !== null && pay > 0n) {
    try {
      inner = acceptTaskCall({ treasury, serial, payDollars: pay });
    } catch {
      inner = null;
    }
  }
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;
  const detail = pay === null ? undefined : `${serial}:${pay}`;
  const taker = data?.task.takenBy ?? null;

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-40 animate-pulse" data-testid="accept-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="accept-read-failed">
        <p className="text-sm">{PAY_READ_FAILED}</p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data)
    body = (
      <>
        <dl className="divide-y divide-white/10">
          <SheetLine label="Pay to" testId="accept-pay-to">
            {workerName}
            <span className="num block break-all text-sm text-muted">
              {taker ?? "nobody has taken it"}
            </span>
          </SheetLine>
          <SheetLine label="Set aside" testId="accept-set-aside">
            {setAsideLine(
              data.task.setAside,
              data.task.deadline ?? data.task.expiresAt,
            )}
          </SheetLine>
        </dl>
        {stops ? (
          <div className="flex flex-col gap-2">
            <p
              className="rounded-xl bg-white/8 px-3 py-2 text-sm"
              data-testid="accept-blocked"
              role="alert"
            >
              {stops.sentence}
            </p>
            {data.task.state === "paid" && recordOwed(task) ? (
              <Button
                data-testid="accept-save-paid"
                onClick={() => {
                  onClose();
                  onPaid();
                }}
                variant="secondary"
              >
                {SAVE_PAID}
              </Button>
            ) : null}
            {stops.sendBackOffered ? (
              <Button
                data-testid="accept-send-back"
                onClick={onSendBack}
                variant="secondary"
              >
                Send the money back
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="text-sm font-semibold">{PAY_CHOICE}</legend>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  checked={choice === "all"}
                  className="size-5 accent-current"
                  data-testid="accept-all"
                  name="accept-choice"
                  onChange={() => setChoice("all")}
                  type="radio"
                  value="all"
                />
                {payAll(setAside)}
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  checked={choice === "part"}
                  className="size-5 accent-current"
                  data-testid="accept-part"
                  name="accept-choice"
                  onChange={() => setChoice("part")}
                  type="radio"
                  value="part"
                />
                {PAY_PART}
              </label>
            </fieldset>
            {choice === "part" ? (
              <Field
                autoComplete="off"
                data-testid="accept-amount"
                hint={`At least ${exactPhrase(setAside < 1_000_000n ? setAside : 1_000_000n)} and at most ${exactPhrase(setAside)}.`}
                inputMode="decimal"
                label={PAY_PART_LABEL}
                onChange={(e) => setTyped(e.target.value)}
                problem={
                  typed !== "" && part && !part.ok ? part.sentence : null
                }
                value={typed}
              />
            ) : null}
            <p className="text-sm" data-testid="accept-left">
              {PAY_FIXED_LEFT} {pay !== null ? goesBack(setAside - pay) : null}
            </p>
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer font-semibold">
                Details
              </summary>
              <p className="mt-1 text-muted">{PAY_DETAILS}</p>
            </details>
            {send?.through === "pair" ? (
              <p className="text-sm text-muted">{PAIR_WORDS}</p>
            ) : null}
          </>
        )}
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={action}
      blocked={!send || stops !== null || pay === null}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={
        send?.through === "pair"
          ? PAY_PRESS_PAIR
          : pay === null || pay === 0n
            ? "Pay"
            : payPress(pay)
      }
      description="The money goes only to the wallet that took the task"
      detail={detail}
      done={
        send?.through === "pair"
          ? PAY_ASKED
          : paidDone(pay ?? setAside, workerName)
      }
      landed={async (wallet) => {
        // A call replaced in the wallet may have landed under another hash: the task is paid on the network.
        const book = data?.book;
        if (!book) return false;
        const row = await readTask(
          (to, call) => wallet.readCall(to, call),
          book,
          serial,
        );
        return row?.state === "paid";
      }}
      lookLabel={PAY_LOOK}
      onLanded={() => {
        if (send?.through !== "pair") onPaid();
      }}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="pay-task"
      recheck={async () => {
        // The network is asked again: the task must still be what the sheet showed, and still payable, or nothing is sent.
        if (!data) return null;
        const fresh = await readTaskNow(ready, treasury, serial, clock);
        const stillWaiting =
          pendingSend(sendKey(action, ready.address)) !== null;
        const moved = stillSo({
          shown: data.task,
          fresh,
          waiting: stillWaiting,
          result: "paid",
          windDownAt: numbers.windDown?.at ?? null,
        });
        if (moved) return moved;
        if (stillWaiting && fresh.task.state === "paid") return null;
        const again = gateOf(fresh.task, Math.max(fresh.time, clock));
        return again.ok ? null : again.sentence;
      }}
      testId="accept-sheet"
      title={payTitle(task.what)}
    >
      {/* What arrives after the sheet opened is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
