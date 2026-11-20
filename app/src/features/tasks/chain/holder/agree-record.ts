/**
 * The helper's yes on a task made for them (plan section 5.8, C35): their own `accept` step carrying `task-pay-to`, the
 * wallet they connected. The relay allows that tag on an `accept` as well as on a `take`; the team's plan of the pay is then
 * checked against this wallet, and the network's payee must be it.
 */
import type { ProjectTask } from "../../task-record";

export { agreeRecord } from "../../task-record";

/**
 * Whether the helper is offered the agree step: this person is the helper a task names, the task pays something and no wallet
 * is named yet, and the task is still theirs to do (not handed in, accepted, given up or stopped).
 */
export function offersAgree(task: ProjectTask, me: string | null): boolean {
  return (
    me !== null &&
    !task.openToAnyone &&
    task.worker === me &&
    task.usd !== null &&
    task.payTo === null &&
    (task.state === "offered" || task.state === "working")
  );
}
