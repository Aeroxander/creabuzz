/**
 * The Send back sheet (plan section 5.6): the team sends a taken task's money back to the project, paying nobody. Offered
 * while the task is taken and its deadline has not passed (after it the network ends the task by itself).
 */
import { rejectTaskCall } from "@creaton/core/pot/pot-calls.ts";
import type { ChainTaskNow } from "@creaton/core/pot/pot-reads.ts";
import type { ProjectNumbers } from "../../../money/numbers";
import type { Ready } from "../../../pot/use-pot";
import { canSendBack, phaseOf } from "../state";
import type { ChainTask } from "../types";
import { notHoldingMoney } from "../words";
import {
  PAY_PRESS_PAIR,
  SEND_BACK_ASKED,
  SEND_BACK_DETAILS,
  SEND_BACK_DONE,
  SEND_BACK_LATE,
  SEND_BACK_LOOK,
  SEND_BACK_PRESS,
  sendBackTitle,
  sendBackWords,
} from "./pay-words";
import { type StepConfig, TaskStepSheet } from "./TaskStepSheet";

/** Why the money cannot be sent back now, or null when it can. */
function stop(task: ChainTaskNow, now: number): string | null {
  if (task.state !== "taken") return notHoldingMoney(phaseOf(task, now));
  return canSendBack(task, now) ? null : SEND_BACK_LATE;
}

export function SendBackSheet({
  numbers,
  what,
  chain,
  ready,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  /** The task's words as the team's record has them; null when no record here is the one the plan was made for. */
  what: string | null;
  chain: ChainTask;
  ready: Ready;
  open: boolean;
  onClose: () => void;
}) {
  const step: StepConfig = {
    action: "send-back-task",
    testId: "send-back-sheet",
    title: sendBackTitle(what),
    description: "Nobody is paid",
    press: SEND_BACK_PRESS,
    pairPress: PAY_PRESS_PAIR,
    look: SEND_BACK_LOOK,
    done: SEND_BACK_DONE,
    asked: SEND_BACK_ASKED,
    result: "rejected",
    call: (treasury, serial) => rejectTaskCall({ treasury, serial }),
    stop,
    words: (now) => (
      <>
        <p className="text-sm" data-testid="send-back-words">
          {sendBackWords(now.setAside)}
        </p>
        <p className="text-sm text-muted">{SEND_BACK_DETAILS}</p>
      </>
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
