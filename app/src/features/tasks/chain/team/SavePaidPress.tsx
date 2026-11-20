/**
 * The team's press when a task was paid on the network and the record on the team's list does not say so yet (plan section
 * 5.5): the payment's transaction is read from the network by the task's number and written on the task. It is also what
 * finishes a payment whose record failed to save, or one a Pair's second signer confirmed later: nothing is paid twice.
 */
import { Button } from "../../../../ui/button";
import { WalletGate } from "../../../pot/use-pot";
import type { TaskSlotProps } from "../slot-props";
import type { ChainTask } from "../types";
import { SAVE_PAID, SAVE_PAID_WORDS } from "./pay-words";
import { useSavePaid } from "./use-save-paid";

export function SavePaidPress(props: TaskSlotProps & { chain: ChainTask }) {
  const { chain, task, numbers, now } = props;
  const save = useSavePaid({
    project: props.project,
    task,
    treasury: numbers.contracts.treasury,
    bookBlock: props.tasks.bookBlock,
    chain,
    fallbackNow: now,
  });
  return (
    <WalletGate chainId={numbers.chainId} what="save that this task was paid">
      {(ready) => (
        <div className="flex flex-col gap-2" data-testid="save-paid">
          <p className="text-sm">{SAVE_PAID_WORDS}</p>
          {save.problem ? (
            <p
              className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
              data-testid="save-paid-problem"
              role="alert"
            >
              {save.problem}
            </p>
          ) : null}
          <Button
            block
            data-testid="save-paid-press"
            disabled={save.busy}
            onClick={() => void save.save(ready)}
          >
            {save.busy ? "Saving…" : SAVE_PAID}
          </Button>
        </div>
      )}
    </WalletGate>
  );
}
