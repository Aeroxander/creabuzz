/**
 * The allowance, for the people who run the project (the founder or runner, or one of a Pair's two signers): what the box holds
 * and the daily rate, a press to draw and one to change the rate. The buttons open the sheets (`AllowanceSheets.tsx`). The
 * weekly check-in is on This week. Everyone else sees the allowance in one sentence on the Back sheet, not here.
 */
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Row } from "../../ui/row";
import { boxNow, rateWords, smallDollarsText } from "../money/copy";
import type { ProjectNumbers } from "../money/numbers";
import { runnerRole } from "../money/runner";
import { AllowanceSheets, useAllowanceState } from "./AllowanceSheets";
import { type Ready, WalletGate } from "./use-pot";

type Sheet = "draw" | "rate" | "apply";

function Inner({
  numbers,
  ready,
  now,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
  now: number;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // The state is read when the card shows, so the sentence beside each button is the chain's own.
  const state = useAllowanceState(numbers, ready, true);
  if (runnerRole(numbers, ready.address).kind === "none") return null;
  if (state.isPending) return <Card className="h-24 animate-pulse" />;
  if (state.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="allowance-read-failed">
        <p className="text-sm">The allowance could not be read.</p>
        <Button onClick={() => void state.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  const a = state.data;
  const box = boxNow(numbers, a.box, a.boxCap);
  const due = a.pending !== null && a.pending.applicableAt <= now;
  return (
    <div className="flex flex-col gap-3">
      <dl className="divide-y divide-white/10">
        <Row
          label="In the box"
          testId="allowance-box"
          value={`${smallDollarsText(box)} dollars`}
        />
        <Row
          label="Daily rate"
          testId="allowance-rate"
          value={rateWords(a.ratePpm)}
        />
      </dl>
      {numbers.windDown !== null ? (
        <p className="text-sm text-muted">
          The allowance is closed: the box went back to the project's money.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            block
            data-testid="allowance-draw"
            disabled={box === 0n}
            onClick={() => setSheet("draw")}
          >
            Draw from the box
          </Button>
          <Button
            block
            data-testid="allowance-rate-open"
            onClick={() => setSheet("rate")}
            variant="secondary"
          >
            Change the rate
          </Button>
          {a.pending ? (
            <Button
              block
              data-testid="allowance-apply"
              onClick={() => setSheet("apply")}
              variant="secondary"
            >
              {due ? "Apply the announced rate" : "See the announced rate"}
            </Button>
          ) : null}
        </div>
      )}
      <AllowanceSheets
        now={now}
        numbers={numbers}
        onClose={() => setSheet(null)}
        ready={ready}
        sheet={sheet}
      />
    </div>
  );
}

/** The allowance card of the Money tab: only for the runner and a Pair's signers. */
export function AllowanceSection({
  numbers,
  address,
  now,
}: {
  numbers: ProjectNumbers;
  /** The account the sender shows, or null. */
  address: string | null;
  now: number;
}) {
  const titleId = useId();
  if (runnerRole(numbers, address).kind === "none") return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="allowance-section"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        The allowance
      </h2>
      <WalletGate chainId={numbers.chainId} what="run the allowance">
        {(ready) => <Inner now={now} numbers={numbers} ready={ready} />}
      </WalletGate>
    </Card>
  );
}
