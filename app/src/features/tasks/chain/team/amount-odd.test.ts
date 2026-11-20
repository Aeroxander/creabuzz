/** What a person can type as a part payment never gives an amount the sheet did not show. */
import { describe, expect, it } from "vitest";
import { partPay } from "./amount";

const MAX = 57_486_851n; // 57.486851 dollars set aside
const odd = [
  "1e3",
  "0x10",
  "١٢",
  "12.",
  ".5",
  "1,5",
  "  12  ",
  "+12",
  "-12",
  "12.50",
  "12.5",
  "12.505",
  "57.48",
  "57.49",
  "57.486851",
  "99999999999999999999999999999999999999",
  "0.0",
  "00012",
  "1_000",
  "12 ",
  "​12",
  "12 ",
  "NaN",
  "Infinity",
  "٣.٥",
];
describe("partPay on odd input", () => {
  for (const typed of odd) {
    it(`"${typed}"`, () => {
      const r = partPay(typed, MAX);
      if (r.ok) {
        // whole cents, at least one dollar, at most what is set aside
        expect(r.raw % 10_000n).toBe(0n);
        expect(r.raw >= 1_000_000n && r.raw <= MAX).toBe(true);
        // and the text said is the amount that is paid
        const asNumber = Number(r.raw) / 1e6;
        expect(
          Math.abs(asNumber - Number(typed.trim().replace(/^\+/, ""))),
        ).toBeLessThan(1e-9);
      }
    });
  }
  it("cannot pay the exact set aside when it has sub-cent digits, but 'pay all' can", () => {
    // 57.486851 is not whole cents: part pay tops out at 57.48, "pay all" pays 57.486851 (the sheet shows both exactly)
    expect(partPay("57.48", MAX).ok).toBe(true);
    expect(partPay("57.49", MAX).ok).toBe(false);
  });
});
