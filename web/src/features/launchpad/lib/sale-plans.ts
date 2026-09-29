/**
 * Sale types → the auction parameters the contract actually consumes.
 *
 * There is one deployed sale primitive: the continuous-clearing auction
 * (`docs/dao-launchpad-plan.md` §7/§9 — "Auction: CCA directly"). It takes a
 * floor price, a tick grid, a graduation threshold and an *issuance schedule*
 * (`sum(mps·blockDelta) == MPS`, steps inside `[startBlock, endBlock]`). The
 * wizard offers three sale shapes in plain language; this module is where
 * each shape becomes those parameters, so nothing is invented:
 *
 * | Wizard choice       | Issuance schedule            | Graduation line |
 * | ------------------- | ---------------------------- | --------------- |
 * | Fixed price         | one flat rate over the window | 100% of the floor raise (sell out or refund) |
 * | Liquidity bootstrap | 70/20/10 across the thirds    | 20% of the floor raise (seed liquidity fast) |
 * | Graduating auction  | `buildSchedule` 60/30/10      | 15% of the floor raise (the app's preset) |
 *
 * The 60/30/10 schedule and the 15% line are exactly what
 * `standardLaunchPreset` has always produced, so choosing the default sale
 * type changes nothing about the deployed shape — pinned by the parity test
 * in `wizard.test.mjs`.
 *
 * Plain-language money lives here too: a founder types a price per token or a
 * raise target in whole units, and these helpers turn that into the Q96 and
 * base-unit integers the record and the contract speak.
 *
 * Alias-free on purpose: `sale-plans.test.mjs` drives it under `node --test`.
 */

import {
  buildSchedule,
  floorPricePerToken,
  MPS,
  Q96,
  snapFloorToGrid,
  tickSpacingFor,
  type AuctionStepInput,
} from "./launch-params.ts";

/** How the tranche comes onto the market. */
export type SaleKind =
  | "fixed-price"
  | "liquidity-bootstrap"
  | "graduating-auction";

export type SaleShape = "flat" | "front-loaded" | "standard";

export interface SalePlan {
  key: SaleKind;
  label: string;
  /** One line, plain language, no blocks and no jargon. */
  blurb: string;
  shape: SaleShape;
  /** Share of the floor raise that must be raised to graduate (percent). */
  thresholdPercent: number;
}

export const SALE_PLANS: Readonly<Record<SaleKind, SalePlan>> = {
  "fixed-price": {
    key: "fixed-price",
    label: "Fixed price",
    blurb:
      "One price, one flat release across the window. The whole tranche sells at the price you set or every bid refunds.",
    shape: "flat",
    thresholdPercent: 100,
  },
  "liquidity-bootstrap": {
    key: "liquidity-bootstrap",
    label: "Liquidity bootstrap",
    blurb:
      "Most of the tranche comes online in the first third of the window to seed trading, and graduates on a modest raise.",
    shape: "front-loaded",
    thresholdPercent: 20,
  },
  "graduating-auction": {
    key: "graduating-auction",
    label: "Graduating auction",
    blurb:
      "A release that starts fast and tapers, with a graduation line: clear it and the sale settles, miss it and every bid refunds.",
    shape: "standard",
    thresholdPercent: 15,
  },
};

export const SALE_KINDS = Object.keys(SALE_PLANS) as SaleKind[];

export function isSaleKind(value: string): value is SaleKind {
  const plans = SALE_PLANS as Readonly<Record<string, SalePlan | undefined>>;
  return plans[value] !== undefined;
}

/** Duration presets. `custom` means "pick the closing day yourself". */
export interface DurationPreset {
  key: "3d" | "7d" | "14d" | "custom";
  label: string;
  seconds: number | null;
}

export const SALE_DURATIONS: readonly DurationPreset[] = [
  { key: "3d", label: "3 days", seconds: 3 * 86_400 },
  { key: "7d", label: "1 week", seconds: 7 * 86_400 },
  { key: "14d", label: "2 weeks", seconds: 14 * 86_400 },
  { key: "custom", label: "Custom end date", seconds: null },
];

/** A sale cannot run for more than this (bounded, and a bounded promise). */
export const MAX_SALE_SECONDS = 180 * 86_400;

export function durationSecondsFor(key: DurationPreset["key"]): number | null {
  return SALE_DURATIONS.find((d) => d.key === key)?.seconds ?? null;
}

/**
 * An issuance schedule with an explicit share per third of the window.
 *
 * Same contract rules as `buildSchedule` (both sums exact, no zero-rate or
 * zero-length step); the residue from integer division is spread as one
 * milli-bip over the first blocks that can absorb it, which keeps the shape
 * the caller asked for instead of dumping it at the end.
 *
 * Returns `[]` when the window cannot express the shares honestly — a window
 * so long that a step would have to sell nothing per block. Callers treat that
 * as "no deployable schedule", never as "sell everything".
 */
export function buildShareSchedule(
  startBlock: bigint,
  endBlock: bigint,
  shares: readonly number[],
): AuctionStepInput[] {
  const span = endBlock - startBlock;
  const count = shares.length;
  if (span < 30n || count === 0) return [];
  const tenths = shares.reduce((total, share) => total + share, 0);
  if (tenths !== 10) return [];

  const deltas: bigint[] = [];
  if (count === 1) {
    deltas.push(span);
  } else if (count === 3) {
    // The same thirds `buildSchedule` splits the window into, so a shape's
    // time axis never differs from the contract's default.
    const first = span / 3n;
    const second = span / 3n;
    deltas.push(first, second, span - first - second);
  } else {
    // Only one third and one whole window are offered; anything else would be
    // inventing a time split the dialog does not describe.
    return [];
  }
  if (deltas.some((delta) => delta <= 0n)) return [];

  const rates: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const target = (MPS * BigInt(shares[i])) / 10n;
    const rate = target / deltas[i];
    if (rate < 1n) return [];
    rates.push(rate);
  }

  let used = 0n;
  for (let i = 0; i < count; i++) used += rates[i] * deltas[i];
  let remainder = MPS - used;
  if (remainder < 0n) return [];

  const steps: AuctionStepInput[] = [];
  for (let i = 0; i < count; i++) {
    const delta = deltas[i];
    const bump = remainder > 0n ? (remainder < delta ? remainder : delta) : 0n;
    const plain = delta - bump;
    if (plain > 0n) steps.push({ mps: rates[i], blockDelta: plain });
    if (bump > 0n) steps.push({ mps: rates[i] + 1n, blockDelta: bump });
    remainder -= bump;
  }
  return steps;
}

/**
 * The issuance schedule for a sale shape.
 *
 * `standard` delegates to `buildSchedule` so the default sale type is
 * byte-identical to what the app has always deployed.
 */
export function scheduleFor(
  shape: SaleShape,
  startBlock: bigint,
  endBlock: bigint,
): AuctionStepInput[] {
  if (shape === "standard") return buildSchedule(startBlock, endBlock);
  if (shape === "flat") return buildShareSchedule(startBlock, endBlock, [10]);
  return buildShareSchedule(startBlock, endBlock, [7, 2, 1]);
}

// ---------------------------------------------------------------------------
// Plain-language money → chain integers
// ---------------------------------------------------------------------------

/** A decimal price string ("0.01") in currency smallest units, or null. */
export function priceToAtomic(
  value: string,
  currencyDecimals = 6,
): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > currencyDecimals) return null;
  const scale = 10n ** BigInt(currencyDecimals);
  const padded = fraction.padEnd(currencyDecimals, "0");
  try {
    return BigInt(whole) * scale + (padded === "" ? 0n : BigInt(padded));
  } catch {
    return null;
  }
}

/**
 * Currency base units → the plain string a person types.
 *
 * `"300000000000"` (USDC's six decimals) becomes `"300000"`, and an unparseable
 * value becomes `""` rather than `0` — a figure the conversion cannot read is
 * not zero, it is unknown.
 */
export function unitsToPlain(value: string | bigint, decimals = 6): string {
  let units: bigint;
  if (typeof value === "bigint") {
    units = value;
  } else {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    if (!/^-?\d+$/.test(trimmed)) return "";
    units = BigInt(trimmed);
  }
  const scale = 10n ** BigInt(decimals);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const sign = negative && whole !== 0n ? "-" : "";
  if (fraction === 0n) return `${sign}${whole.toString()}`;
  const digits = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${digits}`;
}

/**
 * A plain per-token price ("0.000004") → the raw Q96 price the auction reads,
 * NOT snapped to a tick grid (a bidder's price is snapped separately, upward).
 * Null when the text is not a price the currency's decimals can hold.
 */
export function priceToQ96(
  price: string,
  currencyDecimals = 6,
  tokenDecimals = 18,
): bigint | null {
  const atomic = priceToAtomic(price, currencyDecimals);
  if (atomic === null || atomic <= 0n) return null;
  return (atomic * Q96) / 10n ** BigInt(tokenDecimals);
}

/** A Q96 floor price → the plain per-token price the founder typed. */
export function atomicToPrice(
  floorPriceQ96: bigint,
  currencyDecimals = 6,
  tokenDecimals = 18,
): string {
  return unitsToPlain(
    floorPricePerToken(floorPriceQ96, BigInt(tokenDecimals)),
    currencyDecimals,
  );
}

/**
 * A plain price → the deployable `(floorPrice, tickSpacing)` pair.
 *
 * Same construction as `standardLaunchPreset`: raw Q96 price, then a 1bp tick
 * grid snapped down onto it, so `floorPrice % tickSpacing == 0` holds by
 * construction and the default price reproduces `LAUNCH_DEFAULTS` exactly.
 */
export function floorFromPrice(
  price: string,
  currencyDecimals = 6,
  tokenDecimals = 18,
): { floorPrice: bigint; tickSpacing: bigint } | null {
  const atomic = priceToAtomic(price, currencyDecimals);
  if (atomic === null || atomic <= 0n) return null;
  const raw = (atomic * Q96) / 10n ** BigInt(tokenDecimals);
  if (raw <= 0n) return null;
  const tickSpacing = tickSpacingFor(raw);
  return { floorPrice: snapFloorToGrid(raw, tickSpacing), tickSpacing };
}

/** What the whole tranche raises if it all clears at the floor (base units). */
export function floorRaiseAtomic(input: {
  saleTokens: bigint;
  floorPrice: bigint;
}): bigint {
  if (input.saleTokens <= 0n || input.floorPrice <= 0n) return 0n;
  return (input.saleTokens * input.floorPrice) / Q96;
}

/** The graduation line for a sale plan: `thresholdPercent` of the floor raise. */
export function thresholdFromFloor(input: {
  saleTokens: bigint;
  floorPrice: bigint;
  thresholdPercent: number;
}): bigint {
  const raise = floorRaiseAtomic(input);
  if (raise <= 0n || input.thresholdPercent <= 0) return 0n;
  return (raise * BigInt(input.thresholdPercent)) / 100n;
}

/**
 * The inverse: a raise target → the floor price whose graduation line lands on
 * it. Used when the founder states the money they need rather than a price.
 *
 * Rounded up before snapping so the threshold is never *below* the target the
 * founder asked for; the snap-down onto the tick grid keeps the price clean.
 */
export function floorFromRaiseTarget(input: {
  raiseTarget: bigint;
  saleTokens: bigint;
  thresholdPercent: number;
  currencyDecimals?: number;
  tokenDecimals?: number;
}): { floorPrice: bigint; tickSpacing: bigint } | null {
  const { raiseTarget, saleTokens, thresholdPercent } = input;
  if (raiseTarget <= 0n || saleTokens <= 0n || thresholdPercent <= 0) {
    return null;
  }
  const percent = BigInt(thresholdPercent);
  const neededRaise = (raiseTarget * 100n + percent - 1n) / percent;
  const raw = (neededRaise * Q96 + saleTokens - 1n) / saleTokens;
  if (raw <= 0n) return null;
  const tickSpacing = tickSpacingFor(raw);
  const floorPrice = snapFloorToGrid(raw, tickSpacing);
  return { floorPrice, tickSpacing };
}

/** The raise target implied by a price (base units), for the conversion line. */
export function raiseTargetFromPrice(input: {
  price: string;
  saleTokens: bigint;
  thresholdPercent: number;
  currencyDecimals?: number;
}): bigint | null {
  const floor = floorFromPrice(input.price, input.currencyDecimals);
  if (!floor) return null;
  return thresholdFromFloor({
    saleTokens: input.saleTokens,
    floorPrice: floor.floorPrice,
    thresholdPercent: input.thresholdPercent,
  });
}
