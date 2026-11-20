/**
 * The press on a task that ran out (plan section 5.9): anyone who looks at a task whose deadline passed with nobody paid
 * reads it, and can return the money to the project in one press. Nobody has to: every take out, back and claim settles first
 * and returns it too. A plan nobody took has no press: it lapses by itself and moves nothing.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { WalletGate } from "../../../pot/use-pot";
import type { ProjectNumbers } from "../../../money/numbers";
import type { ProjectTask } from "../../task-record";
import { phaseOf } from "../state";
import type { ChainTask } from "../types";
import { RETURN_PRESS, returnLine } from "./holder-words";
import { tiedWords } from "./plan-names";
import { ReturnSheet } from "./ReturnSheet";

export function ReturnOffer({
  chain,
  task,
  numbers,
  now,
}: {
  /** The network's row for the task, or null when the card has none. */
  chain: ChainTask | null;
  /** The team's record of it, or null for a plan that has none here (the sheet then says "a task"). */
  task: ProjectTask | null;
  numbers: ProjectNumbers;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  if (!chain || phaseOf(chain, now, numbers.windDown?.at ?? null) !== "overdue")
    return null;
  return (
    <div className="flex flex-col gap-2" data-testid="return-offer">
      <p className="text-sm" data-testid="return-line">
        {returnLine(chain.deadline ?? chain.expiresAt)}
      </p>
      <WalletGate chainId={numbers.chainId} what="return this money">
        {(ready) => (
          <>
            <Button
              block
              data-testid="return-open"
              onClick={() => setOpen(true)}
              variant="secondary"
            >
              {RETURN_PRESS}
            </Button>
            <ReturnSheet
              numbers={numbers}
              onClose={() => setOpen(false)}
              open={open}
              ready={ready}
              serial={chain.serial}
              what={tiedWords(chain, task)}
            />
          </>
        )}
      </WalletGate>
    </div>
  );
}
