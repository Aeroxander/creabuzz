// A planned task can be taken only while the team's check-in counts: who is told, and when, never from a word of a team record.
import { describe, expect, it } from "vitest";
import { queueOf, sceneNumbers } from "../../../../../tests/helpers/plan-scene";
import { cannotBeTaken } from "./check-in";

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
