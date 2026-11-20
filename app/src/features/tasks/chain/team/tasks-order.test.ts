// The Tasks tab's order: plans that are open first, then the tasks with no plan, then plans that ended; a plan with no record
// here (or a second plan of a record) has its own card; plans that moved nothing are not cards.
import { describe, expect, it } from "vitest";
import {
  planTask,
  queueOf,
  sceneNumbers,
} from "../../../../../tests/helpers/plan-scene";
import type { ProjectTask } from "../../task-record";
import { type TabItem, orderTasks } from "./tasks-order";

const numbers = sceneNumbers();
const queue = queueOf(numbers);
const byState = (state: string) => queue.list.filter((r) => r.state === state);

/** A team record whose id is the row's `what`. */
function recordOf(row: { what: string }, over: Partial<ProjectTask> = {}) {
  return planTask({ id: row.what.slice(2), ...over });
}
const ids = (items: TabItem[]) =>
  items.map((i) =>
    i.kind === "task" ? `task:${i.task.id}` : `plan:${i.row.serial}`,
  );

describe("the order of the Tasks tab", () => {
  it("puts a record whose plan is open first, one without a plan next, one whose plan was paid last", () => {
    const taken = byState("taken")[0];
    const paid = byState("paid")[0];
    if (!taken || !paid) throw new Error("the example lacks a row");
    const open = recordOf(taken);
    const done = recordOf(paid, { state: "accepted" });
    const plain = planTask({ id: "5".repeat(64) });
    const groups = orderTasks(queue, [plain, done, open]);
    expect(ids(groups.planned)).toContain(`task:${open.id}`);
    expect(ids(groups.others)).toEqual([`task:${plain.id}`]);
    expect(ids(groups.ended)).toContain(`task:${done.id}`);
  });

  it("gives a plan with no record here its own card, in serial order with the others that are open", () => {
    const groups = orderTasks(queue, []);
    const open = queue.list.filter(
      (r) => r.state === "announced" || r.state === "taken",
    );
    expect(ids(groups.planned)).toEqual(
      open
        .map((r) => r.serial)
        .sort((a, b) => (a < b ? -1 : 1))
        .map((s) => `plan:${s}`),
    );
    expect(groups.others).toEqual([]);
  });

  it("shows a plan that moved money and has no record, and not one that moved nothing", () => {
    const groups = orderTasks(queue, []);
    const ended = ids(groups.ended);
    for (const row of queue.list) {
      const says = ended.includes(`plan:${row.serial}`);
      const moved =
        row.state === "paid" ||
        row.state === "rejected" ||
        row.state === "returned";
      expect(says).toBe(moved);
    }
  });

  it("a record whose plan ended unpaid is an ordinary task again", () => {
    const withdrawn = byState("cancelled")[0];
    if (!withdrawn) throw new Error("the example has no withdrawn row");
    const record = recordOf(withdrawn);
    const groups = orderTasks(queue, [record]);
    expect(ids(groups.others)).toEqual([`task:${record.id}`]);
    expect(ids(groups.planned)).not.toContain(`task:${record.id}`);
  });

  it("shows a second plan of the same record by itself, so no live plan is out of sight", () => {
    const repeat = queue.list.find((r) => r.repeatOf !== null);
    if (!repeat) throw new Error("the example has no repeat");
    const record = recordOf(repeat);
    const groups = orderTasks(queue, [record]);
    expect(ids(groups.planned)).toContain(`plan:${repeat.serial}`);
    // The first plan of that record (the lowest serial) is on the record's own card, once, and not as a card of its own.
    const all = [...groups.planned, ...groups.others, ...groups.ended];
    expect(ids(all).filter((i) => i === `task:${record.id}`)).toHaveLength(1);
    expect(ids(all)).not.toContain(`plan:${repeat.repeatOf}`);
  });

  it("lists the others in the order the records came, and the ended plans newest first", () => {
    const a = planTask({ id: "1".repeat(64) });
    const b = planTask({ id: "2".repeat(64) });
    expect(ids(orderTasks(queue, [a, b]).others)).toEqual([
      `task:${a.id}`,
      `task:${b.id}`,
    ]);
    const serials = orderTasks(queue, []).ended.map((i) =>
      i.kind === "plan" ? i.row.serial : 0n,
    );
    expect([...serials].sort((x, y) => (x > y ? -1 : 1))).toEqual(serials);
  });
});
