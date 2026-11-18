/**
 * The sums the market screens show: a price per Share from the auction's Q96 prices and the pool's square-root price,
 * how far a 100-dollar buy moves the pool's price (its depth, shown beside the price), and the floor per Share as it
 * melts over the remaining active days. Pure; "about" numbers for people, never what a call sends.
 *
 * Units: dollars have 6 decimals, Shares 18. A Q96 price is raw dollars per raw Share times 2^96.
 */

const Q96 = 2 ** 96;
/** Raw Shares per Share over raw dollars per dollar: a raw ratio times this is dollars per Share. */
const DECIMALS = 1e12;

/** Dollars per Share from an auction price (Q96). */
export function sharePriceFromQ96(q96: bigint): number {
  return (Number(q96) / Q96) * DECIMALS;
}

/** Dollars per Share from the pool's square-root price, given which side the Shares are. */
export function poolSharePrice(
  sqrtPriceX96: bigint,
  sharesAreCurrency0: boolean,
): number {
  const sqrt = Number(sqrtPriceX96) / Q96;
  const p = sqrt * sqrt; // currency1 per currency0, raw
  if (p === 0) return 0;
  return sharesAreCurrency0 ? p * DECIMALS : DECIMALS / p;
}

/** The pool keeps 1 of each 100 traded (`SaleParams.POOL_FEE`). */
const FEE = 0.01;

/**
 * How much a buy of `dollars` raw dollars would lift the pool's price, as a fraction (0.009 is 0.9%), with the liquidity
 * in range now and the 1% fee. Null when the pool has no liquidity.
 */
export function buyMoves(input: {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  sharesAreCurrency0: boolean;
  dollars: bigint;
}): number | null {
  const L = Number(input.liquidity);
  const s = Number(input.sqrtPriceX96) / Q96;
  if (L <= 0 || s <= 0) return null;
  const inAfterFee = Number(input.dollars) * (1 - FEE);
  if (input.sharesAreCurrency0) {
    // Dollars are currency1: paying them in raises sqrt(P) by amount / L, and the price per Share is P.
    const next = s + inAfterFee / L;
    return (next / s) ** 2 - 1;
  }
  // Dollars are currency0: paying them in lowers sqrt(P) (1/sqrt(P') = 1/sqrt(P) + amount / L); the price per Share is 1/P.
  const next = 1 / (1 / s + inAfterFee / L);
  return (s / next) ** 2 - 1;
}

export interface FloorNow {
  /** Dollars in the melting floor (raw). */
  melting: bigint;
  /** Active seconds left before it has all melted into the project's spendable money. */
  meltRemaining: bigint;
  /** Dollars in the floor that never melt (raw). */
  permanentFloor: bigint;
  /** Shares in people's hands (raw). */
  countingSupply: bigint;
  /** All Shares that exist (raw). */
  totalSupply: bigint;
}

/**
 * The floor per Share, in dollars, `seconds` of active time from now: the melting part shrinks evenly to nothing over
 * `meltRemaining`, the permanent part stays. Before any hand-back fee.
 */
export function floorPerShare(floor: FloorNow, seconds: number): number {
  const counting = Number(floor.countingSupply) / 1e18;
  const total = Number(floor.totalSupply) / 1e18;
  const remaining = Number(floor.meltRemaining);
  const left = remaining > 0 ? Math.max(0, 1 - seconds / remaining) : 0;
  const melting = (Number(floor.melting) / 1e6) * left;
  const permanent = Number(floor.permanentFloor) / 1e6;
  return (
    (counting > 0 ? melting / counting : 0) +
    (total > 0 ? permanent / total : 0)
  );
}

/** The melting line as points (days from now, dollars per Share), from now to when it has all melted. */
export function floorLine(
  floor: FloorNow,
  points = 13,
): { day: number; perShare: number }[] {
  const end = Number(floor.meltRemaining);
  return Array.from({ length: points }, (_, i) => {
    const seconds = (end * i) / (points - 1);
    return {
      day: Math.round(seconds / 86_400),
      perShare: floorPerShare(floor, seconds),
    };
  });
}

/** A small dollar price for people: "0.0004", "0.00123", never more than 3 significant figures. */
export function priceText(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) return "0";
  if (dollars >= 1) return dollars.toFixed(2);
  return dollars.toPrecision(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** A fraction as a percent for people: "0.9%", "24%". */
export function percentText(fraction: number): string {
  const p = fraction * 100;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  return `${p.toFixed(2)}%`;
}

/** The hand-back fee: 5 of each 100, or the platform's 1 after a wind-down (rounded up, as the Treasury does). */
export function handBackPaid(slice: bigint, woundDown: boolean): bigint {
  const bps = woundDown ? 100n : 500n;
  return slice - (slice * bps + 9_999n) / 10_000n;
}
