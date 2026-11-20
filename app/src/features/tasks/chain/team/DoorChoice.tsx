/**
 * The two doors for paying a task (plan section 5.1): from the allowance box on any day, or planned so holders get notice
 * first. It shows the one door the rule proposes and one sentence that says why, always. The box door is the step 1 flow
 * that already sits on the card; this adds the sentence, and the plan door's press. A task whose pay the box cannot hold is
 * planned; a task paid to someone who runs the project can only be paid from the box; a pay too big for one task is told so.
 *
 * Shown to the person who runs the project (and to a Pair's signers), on a task someone has taken or agreed to, whose pay is
 * not yet paid and which has no plan on the network. With a plan, the card shows the plan instead (one door per task).
 */
import { nameOf } from "../../../../lib/profiles";
import { Button } from "../../../../ui/button";
import { runnerRole } from "../../../money/runner";
import { WalletGate } from "../../../pot/use-pot";
import { useState } from "react";
import { doorFor } from "../door";
import type { TaskSlotProps } from "../slot-props";
import { PlanSheet } from "./PlanSheet";
import { PLAN_INSTEAD, planButton, waitingForWallet } from "./plan-words";

const DOLLAR = 1_000_000n;

/** The record states a pay can still be planned or drawn for: the work is under way, handed in, or accepted with the pay owed. */
const PLANNABLE = new Set(["working", "submitted", "accepted"]);

/** Whether the door choice belongs on this card: a task with a pay, taken, not paid, and no plan on the network. */
function offersDoor(
  props: Pick<TaskSlotProps, "task" | "chain" | "numbers" | "address">,
): boolean {
  const { task, chain, numbers } = props;
  if (numbers.windDown || runnerRole(numbers, props.address).kind === "none")
    return false;
  if (task.usd === null || task.worker === null) return false;
  if (!PLANNABLE.has(task.state)) return false;
  if (task.state === "accepted" && task.paidTx !== null) return false;
  // A live plan is the one door of this task: the card shows the plan, not a choice.
  return !(
    chain &&
    (chain.state === "announced" ||
      chain.state === "taken" ||
      chain.state === "paid")
  );
}

export function DoorChoice(props: TaskSlotProps) {
  const { task, numbers, tasks: queue, profiles } = props;
  const [open, setOpen] = useState(false);
  if (!offersDoor(props) || task.usd === null || task.worker === null)
    return null;
  const name = task.worker === props.me ? "You" : nameOf(profiles, task.worker);
  if (task.payTo === null)
    return (
      <p className="text-sm text-muted" data-testid="door-waiting">
        {waitingForWallet(name)}
      </p>
    );
  // The card reads the record's own numbers (with their age on the card); the sheet reads the chain when it opens.
  const door = doorFor({
    usd: task.usd,
    box: numbers.allowance.box,
    boxCap: numbers.allowance.boxCap,
    pot: numbers.money.pot,
    payee: task.payTo,
    runner: numbers.runner,
    limits: queue.limits,
    notice: null,
  });
  const plannable = door.door === "plan" || door.planAlso;
  return (
    <div className="flex flex-col gap-2" data-testid="door-choice">
      <p className="text-sm" data-testid="door-sentence" data-door={door.door}>
        {door.sentence}
      </p>
      {plannable ? (
        <WalletGate chainId={numbers.chainId} what="plan this task">
          {(ready) => (
            <>
              {door.door === "plan" ? (
                <Button
                  block
                  data-testid="door-plan"
                  onClick={() => setOpen(true)}
                >
                  {planButton(BigInt(task.usd ?? 0) * DOLLAR)}
                </Button>
              ) : (
                <Button
                  data-testid="door-plan-also"
                  onClick={() => setOpen(true)}
                  size="sm"
                  variant="ghost"
                >
                  {PLAN_INSTEAD}
                </Button>
              )}
              <PlanSheet
                numbers={numbers}
                onClose={() => setOpen(false)}
                open={open}
                queue={queue}
                ready={ready}
                task={task}
                workerName={name}
              />
            </>
          )}
        </WalletGate>
      ) : null}
    </div>
  );
}
