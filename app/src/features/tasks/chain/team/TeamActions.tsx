import { runnerRole } from "../../../money/runner";
import { paidNotRecorded } from "../../paid-journal";
import type { TaskSlotProps } from "../slot-props";
import { canWithdraw, phaseOf, tieOf } from "../state";
import { DoorChoice } from "./DoorChoice";
import { PayPresses } from "./PayPresses";
import { SavePaidPress } from "./SavePaidPress";
import { StopTaskPress } from "./StopTaskPress";
import { recordOwed } from "./use-save-paid";
import { WithdrawPress } from "./WithdrawPress";

/**
 * The team's presses on a task card, for the person who runs the project (and a Pair's two signers): choose a door and plan
 * the pay, pay for the work (in full or in part), send the money back, withdraw a plan, save that a paid task was paid, and
 * stop a task whose plan was withdrawn. What is offered follows the network's row for the task and the clock, never the
 * team's own record; every press is a sheet that reads the network when it opens. After a task's time is up nothing here is
 * offered: the network ends it by itself, and "Return the money" is anyone's.
 */
export function TeamActions(props: TaskSlotProps) {
  const { chain, task, numbers, now } = props;
  if (!chain || runnerRole(numbers, props.address).kind === "none")
    return <DoorChoice {...props} />;
  // The money was paid on the network and the team's record does not say so yet (or the record failed to save): that comes
  // before anything else on this task, and nothing that would pay or send back is offered beside it.
  const unsaved =
    recordOwed(task) &&
    tieOf(chain, task).ok &&
    (chain.state === "paid" || paidNotRecorded(task.id) !== null);
  const withdrawn =
    chain.state === "cancelled" &&
    phaseOf(chain, now, numbers.windDown?.at ?? null) === "withdrawn" &&
    task.state !== "cancelled" &&
    task.state !== "accepted";
  return (
    <>
      <DoorChoice {...props} />
      {canWithdraw(chain, now) ? (
        <WithdrawPress chain={chain} numbers={numbers} what={task.what} />
      ) : null}
      {unsaved ? <SavePaidPress {...props} chain={chain} /> : null}
      {!unsaved && chain.state === "taken" ? (
        <PayPresses {...props} chain={chain} />
      ) : null}
      {withdrawn ? <StopTaskPress {...props} /> : null}
    </>
  );
}
