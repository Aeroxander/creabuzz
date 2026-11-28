/**
 * The top of a project's page for someone who holds Shares in it: what they hold and what taking it out would give now (both
 * read from the chain), the fixed not-a-return sentence beside it, and Take out. It says nothing until the account is ready
 * and holds Shares: a visitor sees Back instead.
 */
import { useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { potProblem } from "../money/problems";
import { goToClaims } from "../tasks/chain/holder/claims-anchor";
import { NOT_A_RETURN, sharesWords, smallDollarsText } from "../money/copy";
import { TakeOutSheet } from "./TakeOutSheet";
import type { MoneyTarget } from "./target";
import { type Ready, useQuietReady } from "./use-pot";
import { useHolding } from "./YourShares";

/** What the record holds about tasks (its limit on how long a task's money can stay set aside), or null when it has none. */
export interface TaskLimits {
  limits: { dueSecs: number };
}

export function HoldingTop({
  target,
  tasks,
  projectName,
  onOpenMoney,
}: {
  target: MoneyTarget;
  /** The record's task queue, handed to the Take out sheet as plain values: the sheet never reads it. */
  tasks: TaskLimits | null;
  projectName: string;
  /** Goes to the Money tab, where what a task owes is claimed. */
  onOpenMoney: () => void;
}) {
  const ready = useQuietReady(target.chainId);
  if (!ready) return null;
  return (
    <Holds
      onOpenMoney={onOpenMoney}
      projectName={projectName}
      ready={ready}
      target={target}
      tasks={tasks}
    />
  );
}

function Holds({
  tasks,
  projectName,
  onOpenMoney,
  ready,
  target,
}: {
  tasks: TaskLimits | null;
  projectName: string;
  onOpenMoney: () => void;
  ready: Ready;
  target: MoneyTarget;
}) {
  const [open, setOpen] = useState(false);
  const reading = useHolding(ready, target);
  if (reading.isError)
    return (
      <Card
        className="flex flex-col gap-2 p-3"
        data-testid="top-holding-failed"
      >
        <p className="text-sm">
          What you hold could not be read. Your money is not affected.{" "}
          {potProblem(reading.error, "take-out")}
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </Card>
    );
  if (!reading.data || reading.data.shares === 0n) return null;
  const { shares, quote } = reading.data;
  return (
    <Card className="flex flex-col gap-2 p-3" data-testid="top-holding">
      <p>
        You hold{" "}
        <span className="num font-semibold" data-testid="holding-shares">
          {sharesWords(shares)} Shares
        </span>
        {quote ? (
          <>
            , worth{" "}
            <span className="num font-semibold" data-testid="holding-cash">
              {smallDollarsText(quote.cashNow)} dollars
            </span>
          </>
        ) : null}
        .
      </p>
      {/* The sentence beside Take out, in one row, so a phone's first screen keeps the banner and Back. */}
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">{NOT_A_RETURN}</p>
        <Button
          className="shrink-0"
          data-testid="holding-take-out"
          onClick={() => setOpen(true)}
        >
          Take out
        </Button>
      </div>
      <TakeOutSheet
        kind="backer"
        onClose={() => setOpen(false)}
        open={open}
        projectName={projectName}
        ready={ready}
        target={target}
        taskInfo={{
          dueSecs: tasks?.limits.dueSecs ?? null,
          ...(tasks ? { onWhereToClaim: () => goToClaims(onOpenMoney) } : {}),
        }}
      />
    </Card>
  );
}
