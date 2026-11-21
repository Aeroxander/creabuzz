/**
 * The team's press on a plan nobody has taken (plan section 5.7): withdraw it. Offered while the plan can still be taken (the
 * notice and the take window); after it the plan lapses by itself and nothing moves.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import type { ProjectNumbers } from "../../../money/numbers";
import { WalletGate } from "../../../pot/use-pot";
import type { ChainTask } from "../types";
import { WITHDRAW_OPEN } from "./pay-words";
import { WithdrawSheet } from "./WithdrawSheet";
import { pressName } from "../../tasks-copy";

export function WithdrawPress({
  numbers,
  chain,
  what,
}: {
  numbers: ProjectNumbers;
  chain: ChainTask;
  /** The task's words from the team's record; null when none is the one this plan was made for. */
  what: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <WalletGate chainId={numbers.chainId} what="withdraw this plan">
      {(ready) => (
        <>
          <Button
            block
            data-testid="withdraw-open"
            aria-label={pressName(WITHDRAW_OPEN, what)}
            onClick={() => setOpen(true)}
            variant="secondary"
          >
            {WITHDRAW_OPEN}
          </Button>
          <WithdrawSheet
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
