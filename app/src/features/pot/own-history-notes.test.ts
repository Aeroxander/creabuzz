// What a Take out remembers about the money it left owed: the serials of the tasks, kept with the step, best effort. A step
// that is not there, storage that cannot be used and a stored value that is not a list of serials lose nothing and throw
// nothing: the look back finds the same claims.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ownNoteSerials,
  ownSteps,
  rememberNotes,
  rememberStep,
  tookOutHere,
} from "./own-history";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const step = (
  n: number,
  over: Partial<Parameters<typeof rememberStep>[1]> = {},
) => ({
  kind: "take-out" as const,
  project: "0xkey",
  at: 1_800_000_000 + n,
  dollars: "1000000",
  shares: "1",
  txHash: tx(n),
  ...over,
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the claims a Take out wrote", () => {
  it("are kept with that step, once each, and read back as serials for the project", () => {
    rememberStep(A, step(1));
    rememberStep(A, step(2));
    rememberNotes(A, tx(1), [5n, 7n, 5n]);
    rememberNotes(A, tx(2), [9n]);
    expect(ownSteps(A, "0xkey").find((s) => s.txHash === tx(1))?.notes).toEqual(
      ["5", "7"],
    );
    expect(ownNoteSerials(A, "0xkey").sort()).toEqual([5n, 7n, 9n]);
    expect(ownNoteSerials(A, "0xother")).toEqual([]);
  });

  it("are never another account's", () => {
    rememberStep(A, step(1));
    rememberStep(B, step(2));
    rememberNotes(A, tx(1), [5n]);
    expect(ownNoteSerials(B, "0xkey")).toEqual([]);
  });

  it("are written only to a step that is there, and nothing is written for none", () => {
    rememberStep(A, step(1));
    rememberNotes(A, tx(99), [5n]);
    rememberNotes(A, tx(1), []);
    expect(ownNoteSerials(A, "0xkey")).toEqual([]);
    // A step that left nothing owed has no list of claims at all, not an empty one.
    expect(ownSteps(A, "0xkey")[0]?.notes).toBeUndefined();
  });

  it("lose nothing and throw nothing when storage cannot be used: this page still remembers", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberNotes(A, tx(1), [5n])).not.toThrow();
    expect(() => ownNoteSerials(A, "0xkey")).not.toThrow();
  });

  it("are dropped when what is stored is not a short list of serials, and the step itself stays out too", () => {
    localStorage.setItem(
      "creaton.pot.history",
      JSON.stringify({
        [A.toLowerCase()]: [
          { ...step(1), notes: ["5"] },
          { ...step(2), notes: ["not a serial"] },
          {
            ...step(3),
            notes: Array.from({ length: 40 }, (_, i) => String(i)),
          },
          { ...step(4), notes: "5" },
        ],
      }),
    );
    expect(ownSteps(A, "0xkey").map((s) => s.txHash)).toEqual([tx(1)]);
  });
});

describe("whether this browser saw a take out", () => {
  it("is true after a take out of the project, and not after a back or a take out of another project", () => {
    rememberStep(A, step(1, { kind: "back" }));
    expect(tookOutHere(A, "0xkey")).toBe(false);
    rememberStep(A, step(2, { project: "0xother" }));
    expect(tookOutHere(A, "0xkey")).toBe(false);
    rememberStep(A, step(3));
    expect(tookOutHere(A, "0xkey")).toBe(true);
    rememberStep(B, step(4, { kind: "take-out-team", project: "0xkey" }));
    expect(tookOutHere(B, "0xkey")).toBe(true);
  });
});
