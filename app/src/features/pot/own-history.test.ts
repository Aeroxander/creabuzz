// What an account did itself, kept in this browser: its own steps only, newest first, each transaction once.
import { afterEach, describe, expect, it } from "vitest";
import { ownSteps, paidInFromHere, rememberStep } from "./own-history";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const step = (
  n: number,
  over: Partial<Parameters<typeof rememberStep>[1]> = {},
) => ({
  kind: "back" as const,
  project: "0xkey",
  at: 1_800_000_000 + n,
  dollars: String(n * 1_000_000),
  shares: String(n),
  txHash: `0x${n.toString(16).padStart(64, "0")}`,
  ...over,
});

afterEach(() => localStorage.clear());

describe("an account's own steps", () => {
  it("are kept newest first, per project, and never mixed with another account's", () => {
    rememberStep(A, step(1));
    rememberStep(A, step(2, { kind: "take-out" }));
    rememberStep(A, step(3, { project: "0xother" }));
    rememberStep(B, step(4));
    expect(ownSteps(A, "0xkey").map((s) => s.at)).toEqual([
      1_800_000_002, 1_800_000_001,
    ]);
    expect(ownSteps(A).length).toBe(3);
    expect(ownSteps(B).length).toBe(1);
  });
  it("the same transaction is kept once", () => {
    rememberStep(A, step(1));
    rememberStep(A, step(1));
    expect(ownSteps(A).length).toBe(1);
  });
  it("what was paid in counts Backs only, in this browser", () => {
    rememberStep(A, step(2));
    rememberStep(A, step(3));
    rememberStep(A, step(5, { kind: "take-out" }));
    expect(paidInFromHere(A, "0xkey")).toBe(5_000_000n);
    expect(paidInFromHere(B, "0xkey")).toBe(0n);
  });
  it("storage that holds nonsense is ignored, not believed", () => {
    localStorage.setItem(
      "creaton.pot.history",
      JSON.stringify({ [A]: [{ kind: "back", project: 1 }, "x"] }),
    );
    expect(ownSteps(A)).toEqual([]);
    localStorage.setItem("creaton.pot.history", "not json");
    expect(ownSteps(A)).toEqual([]);
  });
});
