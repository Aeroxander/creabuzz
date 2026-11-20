/**
 * The Withdraw sheet (plan section 5.7): the team withdraws a plan nobody has taken, so no money moves. Offered while the
 * plan can still be taken (the notice and the take window); after it the plan lapses by itself.
 */
import { cancelTaskCall } from "@creaton/core/pot/pot-calls.ts";
import type { ChainTaskNow } from "@creaton/core/pot/pot-reads.ts";
import type { ProjectNumbers } from "../../../money/numbers";
import type { Ready } from "../../../pot/use-pot";
import type { ProjectTask } from "../../task-record";
import { canWithdraw, phaseOf } from "../state";
import type { ChainTask } from "../types";
import { phaseWord } from "../words";
import {
  PAY_PRESS_PAIR,
  WITHDRAW_ASKED,
  WITHDRAW_DONE,
  WITHDRAW_LATE,
  WITHDRAW_LOOK,
  WITHDRAW_PRESS,
  WITHDRAW_TAKEN,
  WITHDRAW_WORDS,
  withdrawEnded,
  withdrawTitle,
} from "./pay-words";
import { type StepConfig, TaskStepSheet } from "./TaskStepSheet";

/** Why the plan cannot be withdrawn now, or null when it can. */
function stop(task: ChainTaskNow, now: number): string | null {
  if (task.state === "taken") return WITHDRAW_TAKEN;
  if (task.state !== "announced")
    return withdrawEnded(phaseWord(phaseOf(task, now)));
  return canWithdraw(task, now) ? null : WITHDRAW_LATE;
}

export function WithdrawSheet({
  numbers,
  task,
  chain,
  ready,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  task: ProjectTask;
  chain: ChainTask;
  ready: Ready;
  open: boolean;
  onClose: () => void;
}) {
  const step: StepConfig = {
    action: "withdraw-task",
    testId: "withdraw-sheet",
    title: withdrawTitle(task.what),
    description: "No money moves",
    press: WITHDRAW_PRESS,
    pairPress: PAY_PRESS_PAIR,
    look: WITHDRAW_LOOK,
    done: WITHDRAW_DONE,
    asked: WITHDRAW_ASKED,
    result: "cancelled",
    call: (treasury, serial) => cancelTaskCall({ treasury, serial }),
    stop,
    words: () => (
      <p className="text-sm" data-testid="withdraw-words">
        {WITHDRAW_WORDS}
      </p>
    ),
  };
  return (
    <TaskStepSheet
      chain={chain}
      numbers={numbers}
      onClose={onClose}
      open={open}
      ready={ready}
      step={step}
    />
  );
}
