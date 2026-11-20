import { HolderLines } from "./holder/HolderLines";
import { WorkerActions } from "./holder/WorkerActions";
import type { TaskSlotProps } from "./slot-props";
import { TeamActions } from "./team/TeamActions";

/**
 * The three places a task card hands to the task queue screens, mounted once by `TaskCard`: what everyone reads, what the
 * worker can press, what the team can press. The card itself changes only when the screens do not need it to.
 */
export function TaskSlots(props: TaskSlotProps) {
  return (
    <>
      <HolderLines {...props} />
      <WorkerActions {...props} />
      <TeamActions {...props} />
    </>
  );
}
