// The last look before a press (`stillSo`): a task that moved in any way a press depends on stops the press, one fact at a time.
import type { ChainTaskNow } from "@creaton/core/pot/pot-reads.ts";
import { describe, expect, it } from "vitest";
import type { TaskNow } from "./task-now";
import { stillSo } from "./task-now";

const TAKER = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b2";

const taken: ChainTaskNow = {
  serial: 3n,
  what: `0x${"ab".repeat(32)}`,
  payee: null,
  state: "taken",
  shareBps: 100,
  takenBy: TAKER,
  announcedAt: 1_800_000_000,
  noticeEnd: 1_800_001_000,
  expiresAt: 1_800_090_000,
  takenAt: 1_800_002_000,
  deadline: 1_800_090_000,
  maxDollars: 40_000_000n,
  setAside: 40_000_000n,
  stayerClaim: 0n,
  noteFace: 0n,
  returned: 0n,
  notesLeft: 0n,
};
const look = (task: ChainTaskNow): TaskNow => ({
  book: "0x00000000000000000000000000000000000000bb",
  task,
  time: 1_800_010_000,
});
const call = (fresh: ChainTaskNow, waiting = false) =>
  stillSo({ shown: taken, fresh: look(fresh), waiting, result: "paid" });

describe("the last look before a press", () => {
  it("lets the press go on when nothing moved", () => {
    expect(call({ ...taken })).toBeNull();
  });

  it("stops the press when only the taker changed", () => {
    const sentence = call({ ...taken, takenBy: OTHER });
    expect(sentence).toMatch(/changed while you were looking/);
    expect(sentence).toMatch(/Nothing was sent/);
  });

  it.each([
    ["the state", { state: "returned" }],
    ["the money set aside", { setAside: 1n }],
    ["the deadline", { deadline: 1_800_090_001 }],
    ["the end of the window", { expiresAt: 1_800_090_001 }],
    ["the pay-to", { payee: OTHER }],
    ["the task's words", { what: `0x${"cd".repeat(32)}` }],
  ] as const)("stops the press when only %s changed", (_name, change) => {
    expect(call({ ...taken, ...change })).toMatch(
      /changed while you were looking/,
    );
  });

  it("does not stop a press whose own send has landed", () => {
    expect(call({ ...taken, state: "paid" }, true)).toBeNull();
  });
});
