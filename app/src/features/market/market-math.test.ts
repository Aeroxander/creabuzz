import { describe, expect, it } from "vitest";
import {
  buyMoves,
  floorLine,
  floorPerShare,
  handBackPaid,
  percentText,
  poolSharePrice,
  priceText,
  sharePriceFromQ96,
} from "./market-math";

const Q96 = 2n ** 96n;
const SHARE = 10n ** 18n;
const DOLLAR = 10n ** 6n;

/** The pool of a 100,000-dollar auction (plan section 4): 22,000 dollars beside 55,000,000 Shares, all in range. */
const POOL_DOLLARS = 22_000n * DOLLAR;
const POOL_SHARES = 55_000_000n * SHARE;
const L = BigInt(
  Math.round(Math.sqrt(Number(POOL_DOLLARS) * Number(POOL_SHARES))),
);
/** sqrt(dollars / Shares) or sqrt(Shares / dollars), times 2^96, as the pool stores it for each side. */
const sqrtX96 = (ratio: number) =>
  BigInt(Math.round(Math.sqrt(ratio) * 2 ** 96));

describe("market maths", () => {
  it("reads the auction's starting price as 0.0004 dollars a Share", () => {
    // Launcher.salePrices(): 100,000 dollars for all 250,000,000 Shares, on a grid of a hundredth of itself.
    const exact = ((100_000n * DOLLAR) << 96n) / (250_000_000n * SHARE);
    const tick = (exact + 99n) / 100n;
    expect(sharePriceFromQ96(tick * 100n)).toBeCloseTo(0.0004, 9);
    expect(sharePriceFromQ96(Q96)).toBe(1e12);
  });

  it("reads the pool's price the same whichever side the Shares are", () => {
    const sharesFirst = sqrtX96(Number(POOL_DOLLARS) / Number(POOL_SHARES));
    const dollarsFirst = sqrtX96(Number(POOL_SHARES) / Number(POOL_DOLLARS));
    expect(poolSharePrice(sharesFirst, true)).toBeCloseTo(0.0004, 9);
    expect(poolSharePrice(dollarsFirst, false)).toBeCloseTo(0.0004, 9);
  });

  it("finds the plan's depth: a 100-dollar buy lifts a 22,000-dollar pool about 0.9%, 2,500 about 24%", () => {
    for (const [sharesAreCurrency0, sqrt] of [
      [true, sqrtX96(Number(POOL_DOLLARS) / Number(POOL_SHARES))],
      [false, sqrtX96(Number(POOL_SHARES) / Number(POOL_DOLLARS))],
    ] as const) {
      const small = buyMoves({
        sqrtPriceX96: sqrt,
        liquidity: L,
        sharesAreCurrency0,
        dollars: 100n * DOLLAR,
      });
      const large = buyMoves({
        sqrtPriceX96: sqrt,
        liquidity: L,
        sharesAreCurrency0,
        dollars: 2_500n * DOLLAR,
      });
      expect(small).toBeCloseTo(0.009, 3);
      expect(large).toBeCloseTo(0.238, 2);
    }
    expect(
      buyMoves({
        sqrtPriceX96: Q96,
        liquidity: 0n,
        sharesAreCurrency0: true,
        dollars: 1n,
      }),
    ).toBeNull();
  });

  it("melts the floor evenly to its permanent part", () => {
    const floor = {
      melting: 60_000n * DOLLAR,
      meltRemaining: 365n * 86_400n,
      permanentFloor: 1_000n * DOLLAR,
      countingSupply: 250_000_000n * SHARE,
      totalSupply: 1_000_000_000n * SHARE,
    };
    expect(floorPerShare(floor, 0)).toBeCloseTo(0.00024 + 0.000001, 9);
    expect(floorPerShare(floor, 365 * 43_200)).toBeCloseTo(
      0.00012 + 0.000001,
      9,
    );
    expect(floorPerShare(floor, 400 * 86_400)).toBeCloseTo(0.000001, 9);
    const line = floorLine(floor, 5);
    expect(line.map((p) => p.day)).toEqual([0, 91, 183, 274, 365]);
    expect(line[4].perShare).toBeCloseTo(0.000001, 9);
  });

  it("takes the hand-back fee as the Treasury does, and words numbers for people", () => {
    expect(handBackPaid(100n * DOLLAR, false)).toBe(95n * DOLLAR);
    expect(handBackPaid(100n * DOLLAR, true)).toBe(99n * DOLLAR);
    expect(handBackPaid(1n, false)).toBe(0n);
    expect(priceText(0.0004)).toBe("0.0004");
    expect(priceText(0.00123456)).toBe("0.00123");
    expect(priceText(2)).toBe("2.00");
    expect(percentText(0.009)).toBe("0.90%");
    expect(percentText(0.238)).toBe("24%");
  });
});
