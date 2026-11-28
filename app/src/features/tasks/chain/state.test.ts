// The phase of a task at every edge second, and the rules for a task that is open on the network but past its time
// (counts as ended where it matters: what a note pays).
import { describe, expect, it } from "vitest";
import { shapeRow } from "../../../../tests/helpers/chain-task-shape";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import { claimableNow, isPastEnd, phaseOf } from "./state";
import type { ChainTask, ChainTasks } from "./types";

const example = parsedExample();
const queue = example.tasks as ChainTasks;
const at = example.asOf.time;
const byState = (state: ChainTask["state"]) => {
  const row = queue.list.find((r) => r.state === state);
  if (!row) throw new Error(`the example has no ${state} task`);
  return row;
};

describe("phaseOf: every edge second", () => {
  const announced = shapeRow(1n);
  const { noticeEnd, expiresAt } = announced;
  it("a plan in its notice, open to be taken, and missed", () => {
    expect(phaseOf(announced, noticeEnd - 1)).toBe("notice");
    expect(phaseOf(announced, noticeEnd)).toBe("open");
    expect(phaseOf(announced, expiresAt - 1)).toBe("open");
    expect(phaseOf(announced, expiresAt)).toBe("missed");
  });
  const taken = shapeRow(2n, {
    state: "taken",
    takenBy: "0x00000000000000000000000000000000000000a1",
    takenAt: 5_000,
    deadline: 9_000,
    expiresAt: 9_000,
    setAside: 10_000_000n,
  });
  it("a task that is taken is working until its deadline, then overdue", () => {
    expect(phaseOf(taken, 8_999)).toBe("working");
    expect(phaseOf(taken, 9_000)).toBe("overdue");
    expect(phaseOf(taken, 9_001)).toBe("overdue");
  });
  it("each way a task ends has its own phase", () => {
    const ended = (state: ChainTask["state"]) =>
      phaseOf(shapeRow(3n, { state, resolvedAt: 1 }), 1_000_000_000);
    expect(ended("paid")).toBe("paid");
    expect(ended("rejected")).toBe("sent-back");
    expect(ended("returned")).toBe("ran-out");
    expect(ended("cancelled")).toBe("withdrawn");
    expect(ended("lapsed")).toBe("lapsed");
  });
  it("an ended row that came to its end at the wind-down's second was swept, whichever way it ended", () => {
    const sweep = 777;
    for (const state of ["returned", "cancelled"] as const) {
      const row = shapeRow(4n, { state, resolvedAt: sweep });
      expect(phaseOf(row, sweep + 10, sweep)).toBe("wound-down");
      // another second, or no wind-down, is an ordinary end
      expect(
        phaseOf({ ...row, resolvedAt: sweep + 1 }, sweep + 10, sweep),
      ).not.toBe("wound-down");
      expect(phaseOf(row, sweep + 10, null)).not.toBe("wound-down");
    }
    // a task that was paid or sent back before the wind-down stays what it was
    expect(
      phaseOf(shapeRow(5n, { state: "paid", resolvedAt: sweep }), 9_999, sweep),
    ).toBe("paid");
  });
  it("the example's rows, at the record's own time", () => {
    expect(phaseOf(byState("taken"), at)).toBe("working");
    expect(phaseOf(byState("announced"), at)).toBe("notice");
    expect(phaseOf(byState("paid"), at)).toBe("paid");
    expect(phaseOf(byState("rejected"), at)).toBe("sent-back");
    expect(phaseOf(byState("returned"), at)).toBe("ran-out");
    expect(phaseOf(byState("cancelled"), at)).toBe("withdrawn");
    expect(phaseOf(byState("lapsed"), at)).toBe("lapsed");
  });
  it("the same running task a day after its deadline is overdue: the network still says taken until someone settles", () => {
    const row = byState("taken");
    expect(row.state).toBe("taken");
    expect(phaseOf(row, (row.deadline ?? 0) + 86_400)).toBe("overdue");
  });
});

describe("a task that is open on the network but past its time counts as ended (1.6)", () => {
  const announced = shapeRow(1n);
  const taken = shapeRow(2n, {
    state: "taken",
    takenBy: "0x00000000000000000000000000000000000000a1",
    takenAt: 5_000,
    deadline: 9_000,
    expiresAt: 9_000,
    setAside: 100n,
  });
  it("is past its end exactly at expiresAt or the deadline", () => {
    expect(isPastEnd(announced, announced.expiresAt - 1)).toBe(false);
    expect(isPastEnd(announced, announced.expiresAt)).toBe(true);
    expect(isPastEnd(taken, 8_999)).toBe(false);
    expect(isPastEnd(taken, 9_000)).toBe(true);
    expect(isPastEnd(byState("paid"), at)).toBe(false);
  });
});

describe("claimableNow: what a note pays", () => {
  it("nothing while the task runs, the whole note once it passed its deadline unsettled", () => {
    const running = byState("taken");
    expect(claimableNow(running, 500n, at)).toBe(0n);
    expect(claimableNow(running, 500n, (running.deadline ?? 0) - 1)).toBe(0n);
    expect(claimableNow(running, 500n, running.deadline ?? 0)).toBe(500n);
    expect(claimableNow(byState("announced"), 500n, at)).toBe(0n);
  });
  it("an ended task pays the share of the note that came back, rounded down", () => {
    const ended = byState("returned");
    // nothing was paid, all of what was set aside came back
    expect(claimableNow(ended, 1_000n, at)).toBe(1_000n);
    const partly: ChainTask = {
      ...byState("paid"),
      setAside: 300n,
      returned: 100n,
      pay: 200n,
    };
    expect(claimableNow(partly, 10n, at)).toBe(3n);
    expect(claimableNow(partly, 2n, at)).toBe(0n);
  });
  it("nothing when the task was paid in full, never held money, or the note is nothing", () => {
    const full: ChainTask = {
      ...byState("paid"),
      setAside: 300n,
      returned: 0n,
      pay: 300n,
    };
    expect(claimableNow(full, 10n, at)).toBe(0n);
    expect(claimableNow(byState("lapsed"), 10n, at)).toBe(0n);
    expect(claimableNow(byState("returned"), 0n, at)).toBe(0n);
  });
  it("the row of the example that holds a note says what the record says (the chain's own rule, by the record's numbers)", () => {
    const ended = queue.list.find(
      (r) => r.state === "returned" && r.notes && r.notes.holders.length > 0,
    );
    expect(ended).toBeDefined();
    for (const h of ended?.notes?.holders ?? [])
      expect(claimableNow(ended as ChainTask, h.face, at)).toBe(h.claimable);
  });
});
