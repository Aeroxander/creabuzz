import type { TaskSlotProps } from "../slot-props";
import { AgreeButton } from "./AgreeButton";
import { ReturnOffer } from "./ReturnOffer";
import { TakeOffer } from "./TakeOffer";

/**
 * The worker's presses on a task card: agree and name a wallet, set the money aside (only for the wallet a plan names), and
 * return the money after the deadline (anyone's). What is offered follows the network's row and the one clock, never the
 * team's own record. Mounted by `TaskSlots`.
 */
export function WorkerActions(props: TaskSlotProps) {
  return (
    <>
      <AgreeButton {...props} />
      <TakeOffer {...props} />
      <ReturnOffer {...props} />
    </>
  );
}
