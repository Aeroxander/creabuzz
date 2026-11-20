import type { TaskSlotProps } from "../slot-props";
import { DoorChoice } from "./DoorChoice";

/**
 * The team's presses on a task card: choose a door and plan the pay. (Paying in full or in part, sending the money back and
 * withdrawing a plan come with the second pass.) Every press is a sheet that reads the network when it opens.
 */
export function TeamActions(props: TaskSlotProps) {
  return <DoorChoice {...props} />;
}
