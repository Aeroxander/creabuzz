/**
 * The team's press on a taken task that has no task record here to pay against (plan section 5.6): send its money back. A task
 * that has a record gets this press beside "Pay for the work" (`PayPresses`); a plan with no record has only this one.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import type { ProjectNumbers } from "../../../money/numbers";
import { WalletGate } from "../../../pot/use-pot";
import type { ChainTask } from "../types";
import { SEND_BACK_OPEN } from "./pay-words";
import { SendBackSheet } from "./SendBackSheet";

export function SendBackPress({
  numbers,
  chain,
  what,
}: {
  numbers: ProjectNumbers;
  chain: ChainTask;
  what: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <WalletGate chainId={numbers.chainId} what="send this money back">
      {(ready) => (
        <>
          <Button
            block
            data-testid="send-back-open"
            onClick={() => setOpen(true)}
            variant="secondary"
          >
            {SEND_BACK_OPEN}
          </Button>
          <SendBackSheet
            chain={chain}
            numbers={numbers}
            onClose={() => setOpen(false)}
            open={open}
            ready={ready}
            what={what}
          />
        </>
      )}
    </WalletGate>
  );
}
