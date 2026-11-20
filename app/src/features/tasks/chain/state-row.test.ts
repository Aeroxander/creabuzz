// The two built functions of `state.ts`: the one clock, and which network row stands for a team's task record.
import { describe, expect, it } from "vitest";
import {
  shapeRow,
  shapeTaskId,
  shapeTasks,
} from "../../../../tests/helpers/chain-task-shape";
import { chainRowOf, nowOf } from "./state";

describe("nowOf", () => {
  it("is the device clock, but never before the record's own time", () => {
    expect(nowOf(1_000, 2_000)).toBe(2_000);
    // a phone set behind the record cannot make an ended task look open
    expect(nowOf(5_000, 2_000)).toBe(5_000);
    expect(nowOf(2_000, 2_000)).toBe(2_000);
  });

  it("reads the device clock when none is given", () => {
    const before = Math.floor(Date.now() / 1000);
    expect(nowOf(0)).toBeGreaterThanOrEqual(before);
  });
});

describe("chainRowOf", () => {
  const id = shapeTaskId(7);
  const same = (
    serial: bigint,
    state: "announced" | "taken" | "paid" | "returned" | "cancelled" | "lapsed",
  ) => shapeRow(serial, { what: `0x${id}`, state });

  it("finds nothing for a task record with no plan, and nothing for another record's plan", () => {
    const tasks = shapeTasks([shapeRow(1n), shapeRow(2n)]);
    expect(chainRowOf(tasks, id)).toBeNull();
    expect(chainRowOf(shapeTasks([]), id)).toBeNull();
  });

  it("finds the row by the record's id, whatever case the id is in", () => {
    const tasks = shapeTasks([shapeRow(1n), same(2n, "announced")]);
    expect(chainRowOf(tasks, id)?.serial).toBe(2n);
    expect(chainRowOf(tasks, id.toUpperCase())?.serial).toBe(2n);
  });

  it("the plan that binds is the lowest-serial row announced, taken or paid; a later one is a repeat", () => {
    const tasks = shapeTasks([
      same(5n, "announced"),
      same(3n, "taken"),
      same(4n, "paid"),
    ]);
    expect(chainRowOf(tasks, id)?.serial).toBe(3n);
    // a plan that ended unpaid binds nothing: the next live one does
    const after = shapeTasks([same(2n, "cancelled"), same(6n, "announced")]);
    expect(chainRowOf(after, id)?.serial).toBe(6n);
  });

  it("with no live plan, the latest row that ended is the one shown", () => {
    const tasks = shapeTasks([
      same(2n, "cancelled"),
      same(9n, "returned"),
      same(4n, "lapsed"),
    ]);
    expect(chainRowOf(tasks, id)?.serial).toBe(9n);
  });
});
