import { describe, expect, it } from "vitest";
import { partPay } from "./amount";

const MAX = 57_486_851n;

describe("what a person types to pay part", () => {
  it.each([
    ["1", 1_000_000n],
    ["12.5", 12_500_000n],
    ["$12.50", 12_500_000n],
    ["1,000", null],
    ["57.48", 57_480_000n],
  ])("%j", (typed, raw) => {
    const out = partPay(typed, MAX);
    if (raw === null) expect(out.ok).toBe(false);
    else expect(out).toEqual({ ok: true, raw });
  });

  it("says what is wrong, in one sentence each", () => {
    const sentence = (typed: string) => {
      const out = partPay(typed, MAX);
      return out.ok ? null : out.sentence;
    };
    expect(sentence("")).toBe("Type how much to pay.");
    expect(sentence("twelve")).toBe("Use numbers only, like 12 or 12.50.");
    expect(sentence("12.345")).toBe("Pay in dollars and cents, like 12.50.");
    expect(sentence("0.99")).toBe(
      "Pay at least 1 dollar and at most 57.486851 dollars.",
    );
    expect(sentence("58")).toBe(
      "Pay at least 1 dollar and at most 57.486851 dollars.",
    );
  });

  it("never pays more than is set aside, to the unit", () => {
    expect(partPay("57.49", MAX).ok).toBe(false);
    expect(partPay("57.48", MAX).ok).toBe(true);
  });

  it("when less than a dollar is set aside the least is what is set aside", () => {
    expect(partPay("0.5", 500_000n)).toEqual({ ok: true, raw: 500_000n });
  });
});
