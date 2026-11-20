// A planned task can be taken only while the team's check-in counts: who is told, and when, never from a word of a team record.
import { describe, expect, it } from "vitest";
import { queueOf, sceneNumbers } from "../../../../../tests/helpers/plan-scene";
import { cannotBeTaken, plansNeedingCheckIn } from "./check-in";

const numbers = sceneNumbers();
const queue = queueOf(numbers);
const announced = queue.list.filter((r) => r.state === "announced");
const row = announced[0];
if (!row) throw new Error("the example has no announced row");
/** The check-in counts until this second. */
const until = (offset: number) => numbers.asOf.time + offset;

describe("a plan nobody can take unless the team checks in", () => {
  it("is said for everyone when the check-in stops counting by the time it first can be taken, and not a second sooner", () => {
    const now = numbers.asOf.time;
    expect(cannotBeTaken(row, row.noticeEnd, now)).toBe(true);
    expect(cannotBeTaken(row, row.noticeEnd - 1, now)).toBe(true);
    expect(cannotBeTaken(row, row.noticeEnd + 1, now)).toBe(false);
  });

  it("once open, it is said when the check-in has already stopped counting", () => {
    const now = row.noticeEnd + 10;
    expect(cannotBeTaken(row, now, now)).toBe(true);
    expect(cannotBeTaken(row, now + 1, now)).toBe(false);
  });

  it("says nothing without a check-in date, for a task that is not planned, or for one whose time is up", () => {
    const now = numbers.asOf.time;
    expect(cannotBeTaken(row, null, now)).toBe(false);
    const taken = queue.list.find((r) => r.state === "taken");
    if (!taken) throw new Error("the example has no taken row");
    expect(cannotBeTaken(taken, until(0), now)).toBe(false);
    expect(cannotBeTaken(row, until(0), row.expiresAt + 1)).toBe(false);
  });
});

describe("the planned tasks whose take window the last check-in does not cover", () => {
  it("counts those whose window ends after the check-in stops counting, and starts at the first moment any can be taken", () => {
    const now = numbers.asOf.time;
    const ends = announced.map((r) => r.expiresAt);
    const need = plansNeedingCheckIn(queue, Math.min(...ends) - 1, now);
    expect(need?.count).toBeGreaterThanOrEqual(1);
    const all = plansNeedingCheckIn(queue, Math.min(...ends) - 1, now);
    expect(all?.from).toBe(
      Math.min(...announced.map((r) => Math.max(r.noticeEnd, now))),
    );
    // A check-in that counts until the last window ends covers them all.
    expect(plansNeedingCheckIn(queue, Math.max(...ends), now)).toBeNull();
    expect(plansNeedingCheckIn(queue, null, now)).toBeNull();
  });

  it("the count follows the check-in date: one more second covers one more plan", () => {
    const now = numbers.asOf.time;
    const sorted = [...announced.map((r) => r.expiresAt)].sort((a, b) => a - b);
    const all = plansNeedingCheckIn(queue, (sorted[0] ?? 0) - 1, now);
    expect(all?.count).toBe(announced.length);
    if (sorted.length > 1 && sorted[0] !== sorted[1]) {
      const rest = plansNeedingCheckIn(queue, sorted[0] ?? 0, now);
      expect(rest?.count).toBe(announced.length - 1);
    }
  });
});
