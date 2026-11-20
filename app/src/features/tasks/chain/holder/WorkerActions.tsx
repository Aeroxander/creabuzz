import type { TaskSlotProps } from "../slot-props";
import { AgreeButton } from "./AgreeButton";

/**
 * The worker's presses on a task card: agree and name a wallet (built), set the money aside, return the money after the
 * deadline. The worker-side work (WP5) replaces this file and keeps its name, its props and the agree step.
 */
export function WorkerActions(props: TaskSlotProps) {
  return <AgreeButton {...props} />;
}
