/**
 * The calls waiting for both signers of a Pair. The second signer reads, for each, a sentence that names what it does, to
 * whom and how much (`pair-terms.ts`), then confirms it; the one who asked can withdraw it. A call the app cannot read is
 * shown as unknown and cannot be confirmed from here, so nobody signs blind.
 */
import {
  pairCancelCall,
  pairConfirmCall,
} from "@creaton/core/pot/pot-calls.ts";
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import { signsForRunner } from "../money/numbers";
import {
  describePotCall,
  type OwedTask,
  type PairTaskFacts,
  type Terms,
} from "./pair-terms";
import { PotSheet } from "./PotSheet";
import { type Proposal, usePairWaiting } from "./use-pair-waiting";
import { type Ready, WalletGate } from "./use-pot";

type Step = {
  kind: "confirm" | "withdraw";
  proposal: Proposal;
  terms: Terms;
} | null;

function Inner({
  numbers,
  ready,
  nameOf,
  tasksFor,
  taskWordsOf,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
  nameOf: (address: string) => string;
  tasksFor?: (payee: string, raw: bigint) => readonly OwedTask[];
  taskWordsOf?: (what: string) => string | null;
}) {
  const pair = numbers.contracts.pair;
  const waiting = usePairWaiting(
    pair,
    ready,
    numbers.chainId,
    numbers.contracts.treasury,
  );
  const [step, setStep] = useState<Step>(null);
  if (!pair) return null;
  if (waiting.isPending)
    return <p className="text-sm text-muted">Looking on the network…</p>;
  if (waiting.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="pair-read-failed">
        <p className="text-sm">
          The waiting calls could not be read from the network. Nothing changed.
        </p>
        <Button onClick={() => void waiting.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  const list = waiting.data.waiting;
  const me = ready.address;
  // What the network says about the tasks the waiting calls name, read when they were listed: no facts, no task sentence.
  const read = waiting.data.facts;
  const facts: PairTaskFacts | undefined = read
    ? {
        taskFacts: (serial) => read.tasks.get(String(serial)) ?? null,
        noticeFor: (share) => read.notices.get(share) ?? null,
        now: read.now,
        recordWords: (what) => taskWordsOf?.(what) ?? null,
      }
    : undefined;
  const call = step
    ? step.kind === "confirm"
      ? pairConfirmCall(
          pair,
          step.proposal.target,
          step.proposal.data,
          step.proposal.nonce,
        )
      : pairCancelCall(pair, step.proposal.id)
    : null;
  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? (
        <p className="text-sm text-muted" data-testid="pair-none">
          {waiting.data.complete
            ? "Nothing is waiting."
            : "Nothing waiting in the last stretch of blocks."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((proposal) => {
            const terms = describePotCall(
              numbers,
              proposal.target,
              proposal.data,
              nameOf,
              tasksFor,
              facts,
            );
            const mine = proposal.by === me.toLowerCase();
            return (
              <li
                className="flex flex-col gap-2 rounded-xl bg-white/6 px-3 py-2"
                data-testid="pair-waiting-call"
                key={proposal.id}
              >
                <p
                  className={`break-words text-sm ${terms.kind === "unknown" ? "text-danger" : "font-semibold"}`}
                  data-testid="pair-terms"
                >
                  {terms.words}
                </p>
                {terms.more?.map((line) => (
                  <p
                    className="break-words text-xs text-muted"
                    data-testid="pair-terms-more"
                    key={line}
                  >
                    {line}
                  </p>
                ))}
                <p className="text-xs text-muted">
                  {mine
                    ? "You asked. It happens when the other signer confirms."
                    : `${nameOf(proposal.by)} asked. It happens when you confirm.`}
                </p>
                {mine ? (
                  <Button
                    data-testid="pair-withdraw"
                    onClick={() =>
                      setStep({ kind: "withdraw", proposal, terms })
                    }
                    size="sm"
                    variant="ghost"
                  >
                    Withdraw
                  </Button>
                ) : terms.kind === "unknown" ? (
                  <p
                    className="text-xs text-muted"
                    data-testid="pair-cannot-confirm"
                  >
                    This cannot be confirmed from here.
                  </p>
                ) : (
                  <Button
                    data-testid="pair-review"
                    onClick={() =>
                      setStep({ kind: "confirm", proposal, terms })
                    }
                    size="sm"
                  >
                    Review and confirm
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <PotSheet
        account={ready.address}
        action={`pair-${step?.kind ?? "confirm"}:${numbers.chainId}:${pair}:${step?.proposal.id ?? ""}`}
        blocked={step?.kind === "confirm" && step.terms.kind === "unknown"}
        calls={call ? [call] : null}
        chainId={numbers.chainId}
        confirmLabel={step?.kind === "withdraw" ? "Withdraw it" : "Confirm"}
        done={step?.kind === "withdraw" ? "Withdrawn." : "Confirmed. It ran."}
        lookLabel="Look for your step"
        onOpenChange={(next) => {
          if (!next) setStep(null);
        }}
        open={step !== null}
        playMoney={numbers.playMoney}
        problemAction="pair"
        testId="pair-sheet"
        title={
          step?.kind === "withdraw"
            ? "Withdraw this call?"
            : "Confirm this call?"
        }
      >
        {step ? (
          <>
            <p
              className="break-words text-sm font-semibold"
              data-testid="pair-sheet-terms"
            >
              {step.terms.words}
            </p>
            {step.terms.more?.map((line) => (
              <p className="text-xs text-muted" key={line}>
                {line}
              </p>
            ))}
            {step.terms.names.length > 0 ? (
              <ul className="text-xs text-muted" data-testid="pair-sheet-names">
                {step.terms.names.map((n) => (
                  <li className="break-all" key={n}>
                    {nameOf(n)}: {n}
                  </li>
                ))}
              </ul>
            ) : null}
            {step.kind === "confirm" ? (
              <p className="text-sm text-muted">
                Confirming runs it now. It cannot be undone.
              </p>
            ) : null}
          </>
        ) : null}
      </PotSheet>
    </div>
  );
}

/** The waiting calls card of the Money tab: only for a Pair's two signers. */
export function PairWaiting({
  numbers,
  address,
  nameOf,
  tasksFor,
  taskWordsOf,
}: {
  numbers: ProjectNumbers;
  address: string | null;
  nameOf: (address: string) => string;
  /** The names of the accepted tasks that are owed exactly this much at this wallet, for a draw that pays one. */
  tasksFor?: (payee: string, raw: bigint) => readonly OwedTask[];
  /** The team's own words for the task record with this id (a task call's `what`), when the project has one. */
  taskWordsOf?: (what: string) => string | null;
}) {
  const titleId = useId();
  if (!numbers.contracts.pair || !signsForRunner(numbers, address)) return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="pair-card"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        Waiting for both of you
      </h2>
      <WalletGate
        chainId={numbers.chainId}
        what="see the calls waiting for you"
      >
        {(ready) => (
          <Inner
            nameOf={nameOf}
            numbers={numbers}
            ready={ready}
            taskWordsOf={taskWordsOf}
            tasksFor={tasksFor}
          />
        )}
      </WalletGate>
    </Card>
  );
}
