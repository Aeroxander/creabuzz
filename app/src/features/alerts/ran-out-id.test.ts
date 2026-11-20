// A taken task that runs out is new news: "was taken" and "ran out" are two ids, so a holder who read the first is told the second.
import { describe, expect, it } from "vitest";
import { takenNumbers, takenRowOf } from "../../../tests/helpers/plan-scene";
import { alertsOf } from "./alerts";

describe("a taken task that runs out is new news", () => {
  it("gives the 'ran out' news another id than the 'was taken' news", () => {
    const numbers = takenNumbers();
    const row = takenRowOf(numbers);
    const deadline = row.deadline ?? row.expiresAt;
    const at = (now: number) =>
      alertsOf({
        numbers: [numbers],
        names: new Map(),
        me: ["0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"],
        held: () => true,
        tasksOf: () => undefined,
        now,
      }).find((a) => a.serial === row.serial);
    const before = at(deadline - 100);
    const after = at(deadline + 100);
    expect(before?.said).toMatch(/was taken/);
    expect(after?.said).toMatch(/ran out/);
    expect(after?.id).not.toBe(before?.id);
  });
});
