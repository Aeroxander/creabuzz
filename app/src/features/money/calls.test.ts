import { describe, expect, it } from "vitest";
import { parseDollarAmount } from "./calls";

const MIN = 1_000_000n;

describe("typed dollars", () => {
  it("reads to 6 decimals, with a dollar sign and thousands marks, from the project's own smallest amount", () => {
    expect(parseDollarAmount("25", MIN)).toEqual({
      ok: true,
      raw: 25_000_000n,
    });
    expect(parseDollarAmount("$1,000.5", MIN)).toEqual({
      ok: true,
      raw: 1_000_500_000n,
    });
    expect(parseDollarAmount("1.000001", MIN)).toEqual({
      ok: true,
      raw: 1_000_001n,
    });
  });

  it("says what is wrong: nothing typed, not a number, too many decimals, below the smallest", () => {
    expect(parseDollarAmount(" ", MIN)).toEqual({ ok: false, reason: "empty" });
    expect(parseDollarAmount("ten", MIN)).toEqual({
      ok: false,
      reason: "format",
    });
    expect(parseDollarAmount("1.0000001", MIN)).toEqual({
      ok: false,
      reason: "format",
    });
    expect(parseDollarAmount("-5", MIN)).toEqual({
      ok: false,
      reason: "format",
    });
    expect(parseDollarAmount("0.99", MIN)).toEqual({
      ok: false,
      reason: "small",
    });
    // The smallest comes from the record, not from this file: a project asking for 5 refuses 4.99.
    expect(parseDollarAmount("4.99", 5_000_000n)).toEqual({
      ok: false,
      reason: "small",
    });
    expect(parseDollarAmount("5", 5_000_000n).ok).toBe(true);
  });
});
