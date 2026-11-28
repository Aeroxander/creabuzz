// What people type, read strictly: a rate in percent a day and a count of Shares. Anything that is not exactly one of them
// is nothing, never a guess.
import { describe, expect, it } from "vitest";
import { S } from "../../../tests/helpers/pot-harness";
import { parseRate } from "./AllowanceSheets";
import { parseShares } from "./GrantSheet";

describe("a rate typed as a percent a day", () => {
  it("reads in parts per million", () => {
    expect(parseRate("0.10")).toBe(1_000);
    expect(parseRate("0.1")).toBe(1_000);
    expect(parseRate("0.2%")).toBe(2_000);
    expect(parseRate("1")).toBe(10_000);
    expect(parseRate("0")).toBe(0);
    expect(parseRate("0.0001")).toBe(1);
  });
  it("is nothing when it is not a rate", () => {
    for (const text of [
      "",
      "abc",
      "-1",
      "0.00001",
      "1,5",
      "1e3",
      "0.1.2",
      "1000",
    ])
      expect(parseRate(text), text).toBeNull();
  });
});

describe("Shares typed by a person", () => {
  it("reads whole and part Shares in raw units", () => {
    expect(parseShares("1,500")).toBe(1_500n * S);
    expect(parseShares("0.5")).toBe(S / 2n);
    expect(parseShares("12.000000000000000001")).toBe(12n * S + 1n);
  });
  it("is nothing when it is not a number of Shares", () => {
    for (const text of ["", "x", "-1", "1.0000000000000000001", "1e3", "1..2"])
      expect(parseShares(text), text).toBeNull();
  });
});
