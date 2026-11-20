/**
 * The order of the Tasks tab (plan section 5.11): plans that are open on the network first (planned or taken), then the
 * tasks that have no plan, then plans that ended. A plan with no task record here that names it gets its own card, so a team
 * cannot plan something a holder cannot see; so does a second plan of the same record (it is never paid, and is still shown).
 * Pure.
 */
import type { ProjectTask } from "../../task-record";
import { chainRowOf } from "../state";
import type { ChainTask, ChainTasks } from "../types";

/** One entry of the tab: a team record, or a plan on its own. */
export type TabItem =
  | { kind: "task"; task: ProjectTask }
  | { kind: "plan"; row: ChainTask };

const OPEN = new Set(["announced", "taken"]);
/** Ended plans that moved money; one that moved nothing (withdrawn, lapsed) is not a card of its own. */
const MONEY_MOVED = new Set(["rejected", "returned"]);

/** The tab's three groups. `tasks` are in the order the records were given (newest first). */
export function orderTasks(
  queue: ChainTasks,
  records: readonly ProjectTask[],
): { planned: TabItem[]; others: TabItem[]; ended: TabItem[] } {
  const planned: { item: TabItem; serial: bigint }[] = [];
  const ended: { item: TabItem; serial: bigint }[] = [];
  const others: TabItem[] = [];
  // The row that binds each record is shown on the record's card; every other row of the queue is shown by itself.
  const binding = new Set<bigint>();
  for (const task of records) {
    const row = chainRowOf(queue, task.id);
    const item: TabItem = { kind: "task", task };
    if (row === null) {
      others.push(item);
    } else if (OPEN.has(row.state)) {
      binding.add(row.serial);
      planned.push({ item, serial: row.serial });
    } else if (row.state === "paid") {
      binding.add(row.serial);
      ended.push({ item, serial: row.serial });
    } else {
      // A plan that ended unpaid binds nothing: the record is an ordinary task again.
      others.push(item);
    }
  }
  const recordIds = new Set(records.map((t) => `0x${t.id.toLowerCase()}`));
  for (const row of queue.list) {
    if (binding.has(row.serial)) continue;
    const alone: TabItem = { kind: "plan", row };
    if (OPEN.has(row.state)) planned.push({ item: alone, serial: row.serial });
    else if (
      row.state === "paid" ||
      (MONEY_MOVED.has(row.state) && !recordIds.has(row.what))
    )
      ended.push({ item: alone, serial: row.serial });
  }
  const up = (a: { serial: bigint }, b: { serial: bigint }) =>
    a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0;
  return {
    planned: planned.sort(up).map((e) => e.item),
    others,
    ended: ended.sort((a, b) => up(b, a)).map((e) => e.item),
  };
}
