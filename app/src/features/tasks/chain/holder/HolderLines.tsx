import type { TaskSlotProps } from "../slot-props";
import { PlannedLines } from "./PlannedLines";

/**
 * What every holder reads on a task's card (plan section 5.3): a plan in its notice or take window in two lines, signed in or
 * not. A task that was taken or has ended already has the network's headline on the card (`PlanState`), so nothing more is
 * said for it here. Mounted by `TaskSlots`; draws nothing for a task with no plan.
 */
export function HolderLines({
  chain,
  task,
  numbers,
  now,
  profiles,
}: TaskSlotProps) {
  if (chain?.state !== "announced") return null;
  return (
    <PlannedLines
      numbers={numbers}
      now={now}
      profiles={profiles}
      row={chain}
      task={task}
      withAge={false}
    />
  );
}
