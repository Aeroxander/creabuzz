/**
 * The team's press on a plan nobody has taken (plan section 5.7): withdraw it. Offered while the plan can still be taken (the
 * notice and the take window); after it the plan lapses by itself and nothing moves.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { WalletGate } from "../../../pot/use-pot";
import type { TaskSlotProps } from "../slot-props";
import type { ChainTask } from "../types";
import { WITHDRAW_OPEN } from "./pay-words";
import { WithdrawSheet } from "./WithdrawSheet";

export function WithdrawPress(props: TaskSlotProps & { chain: ChainTask }) {
  const [open, setOpen] = useState(false);
  const { chain, task, numbers } = props;
  return (
    <WalletGate chainId={numbers.chainId} what="withdraw this plan">
      {(ready) => (
        <>
          <Button
            block
            data-testid="withdraw-open"
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
            task={task}
          />
        </>
      )}
    </WalletGate>
  );
}
