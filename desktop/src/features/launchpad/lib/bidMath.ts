/**
 * Pure bid math for the in-app launchpad bid flow: raw form strings in, a
 * validated `BidPlan` plus inline field issues out. Nothing here touches the
 * network, the clock, or the DOM (the same discipline as `./evmCalls.ts`), so
 * the whole surface is deterministically testable under `node --test`
 * (`bidMath.test.mjs`).
 *
 * Ported faithfully from the web launchpad's tick/validation math:
 * - `snapMaxPriceToTick`, `validateBid`, `BidIssue` —
 *   `web/src/features/launchpad/lib/bid-tx.ts`
 * - `maxBidPrice`, `Q96`, `q96FromPrice`, `floorPricePerToken` —
 *   `web/src/features/launchpad/lib/launch-params.ts` (which mirrors the
 *   auction contract's `ConstantsLib` / `MaxBidPriceLib` / `TickStorage`)
 * - `parseBaseUnits` — `web/src/features/launchpad/lib/amounts.ts` (`toAtomic`)
 *
 * `bidMath.test.mjs` golden-tests every ported function against the vectors
 * from `web/src/features/launchpad/lib/launch-params.test.mjs`,
 * `web/src/features/launchpad/lib/bid-tx.test.mjs`, and
 * `web/src/features/launchpad/lib/amounts.test.mjs`, cited per test.
 *
 * Deliberate deviations (composition, never arithmetic):
 * - `validateBid` takes `clearingPriceQ96: bigint | null`; `null` skips the
 *   above-clearing check (the contract still enforces it onchain). The web
 *   dialog composes the same behavior by passing `clearing ?? 0n` and then
 *   filtering the clearing issue out when its read failed
 *   (`web/src/features/launchpad/ui/RecordBidDialog.tsx`).
 * - `amountBoundsIssue` adds the uint128 calldata-width bound on the budget
 *   (`submitBid`'s `uint128 amount`, `./evmCalls.ts` `SUBMIT_BID_TYPES`); the
 *   web encoder would otherwise throw deep inside ABI encoding instead of the
 *   form naming the field.
 */

import {
  bidPlanWithDefaultHint,
  type BidPlan,
} from "@/features/launchpad/lib/evmCalls";

/** Q96 fixed-point denominator. Port of `web/.../launch-params.ts`. */
export const Q96 = 1n << 96n;

/** The auction's flat price ceiling applies through this supply (2^62). */
const LOWER_TOTAL_SUPPLY_THRESHOLD = 1n << 62n;
/** `uint160.max` — the ceiling for supplies at or below the threshold. */
const MAX_V4_PRICE = (1n << 160n) - 1n;
/**
 * The widest bid amount `submitBid` can carry: its `amount` parameter is a
 * `uint128` (`./evmCalls.ts` `SUBMIT_BID_TYPES`), so anything wider reverts in
 * the ABI decoder before the contract ever sees it.
 */
export const MAX_BID_AMOUNT_UNITS = (1n << 128n) - 1n;

const AMOUNT_NOT_POSITIVE_MESSAGE = "The bid needs a budget greater than zero.";

/** The highest Q96 price a given sold supply supports (`MaxBidPriceLib`). */
export function maxBidPrice(totalSupply: bigint): bigint {
  if (totalSupply <= 0n) return 0n;
  if (totalSupply <= LOWER_TOTAL_SUPPLY_THRESHOLD) return MAX_V4_PRICE;
  const liquidityBound = ((1n << 154n) / totalSupply) ** 2n;
  const raisedBound = (1n << 222n) / totalSupply;
  return liquidityBound < raisedBound ? liquidityBound : raisedBound;
}

/** Q96 price for `whole` currency units per whole token. */
export function q96FromPrice(
  wholePrice: bigint,
  tokenDecimals = 18n,
  currencyDecimals = 6n,
): bigint {
  return (wholePrice * 10n ** currencyDecimals * Q96) / 10n ** tokenDecimals;
}

/**
 * Price of a whole token implied by a Q96 floor, in currency **smallest units**
 * (so 10_000 with USDC's 6 decimals is $0.01 per token) — the display inverse
 * of {@link q96FromPrice}. Port of `web/.../launch-params.ts` verbatim.
 */
export function floorPricePerToken(
  floorPriceQ96: bigint,
  tokenDecimals = 18n,
): bigint {
  return (floorPriceQ96 * 10n ** tokenDecimals) / Q96;
}

/**
 * Snap a desired Q96 price onto the auction's tick grid — the smallest price
 * at or above `desiredQ96` that is a multiple of `tickSpacingQ96`. Mirrors the
 * invariant `TickStorage._getTick` enforces (price % spacing == 0). Port of
 * `web/src/features/launchpad/lib/bid-tx.ts`.
 */
export function snapMaxPriceToTick(
  desiredQ96: bigint,
  tickSpacingQ96: bigint,
): bigint {
  if (tickSpacingQ96 <= 0n) return desiredQ96;
  const snapped = desiredQ96 - (desiredQ96 % tickSpacingQ96);
  // A bid at or below the clearing price fills at most partially; snapping up
  // keeps the user's intended premium rather than silently undercutting it.
  return snapped === desiredQ96 ? snapped : snapped + tickSpacingQ96;
}

/** One inline validation complaint, keyed to a form field. */
export interface BidIssue {
  field: "amount" | "maxPrice" | "network";
  severity: "error" | "warning";
  message: string;
}

/**
 * Validate a bid against the exact rules the contract enforces in `_submitBid`
 * and `TickStorage._getTick`, before anything is sent:
 *
 * - `maxPriceQ96 % tickSpacingQ96 == 0` (tick-aligned; `TickPriceNotAtBoundary`)
 * - `maxPriceQ96 > clearingPriceQ96` (`BidMustBeAboveClearingPrice`); skipped
 *   when `clearingPriceQ96` is `null` — the caller could not read it
 * - `maxPriceQ96 <= MAX_BID_PRICE` computed from supply (`InvalidBidPriceTooHigh`)
 * - `amount > 0` (`BidAmountTooSmall`)
 *
 * A bid that passes this list is still not guaranteed to land (the hook can
 * reject, the auction can sell out); an issue raised here is guaranteed to
 * revert onchain, so the flow should refuse to send. Port of
 * `web/src/features/launchpad/lib/bid-tx.ts` (message strings kept verbatim so
 * the web golden vectors apply unchanged).
 */
export function validateBid(
  plan: BidPlan,
  context: {
    tickSpacingQ96: bigint;
    clearingPriceQ96: bigint | null;
    /** Auction `TOTAL_SUPPLY`; `null` when the record does not carry it. */
    supply: bigint | null;
  },
): BidIssue[] {
  const issues: BidIssue[] = [];
  if (plan.amount <= 0n) {
    issues.push({
      field: "amount",
      severity: "error",
      message: AMOUNT_NOT_POSITIVE_MESSAGE,
    });
  }
  if (context.supply !== null) {
    const ceiling = maxBidPrice(context.supply);
    if (plan.maxPriceQ96 > ceiling) {
      issues.push({
        field: "maxPrice",
        severity: "error",
        message: `This max price is above the supply's ceiling (${ceiling}); the contract would revert InvalidBidPriceTooHigh.`,
      });
    }
  }
  if (
    context.tickSpacingQ96 > 0n &&
    plan.maxPriceQ96 % context.tickSpacingQ96 !== 0n
  ) {
    issues.push({
      field: "maxPrice",
      severity: "error",
      message: `Max price must sit on the auction's tick grid (a multiple of ${context.tickSpacingQ96}); the contract would revert TickPriceNotAtBoundary.`,
    });
  }
  if (
    context.clearingPriceQ96 !== null &&
    plan.maxPriceQ96 <= context.clearingPriceQ96
  ) {
    issues.push({
      field: "maxPrice",
      severity: "error",
      message: "Max price must be above the current clearing price.",
    });
  }
  return issues;
}

/**
 * The calldata-width bound on a bid amount (`submitBid`'s `uint128`). The
 * "greater than zero" rule lives in {@link validateBid}; this only refuses
 * amounts the ABI cannot carry.
 */
export function amountBoundsIssue(amount: bigint): BidIssue | null {
  if (amount > MAX_BID_AMOUNT_UNITS) {
    return {
      field: "amount",
      severity: "error",
      message: `The budget exceeds the auction's bid-amount bound of ${MAX_BID_AMOUNT_UNITS} (uint128 base units).`,
    };
  }
  return null;
}

/**
 * A bigint from a decimal string, or null when the input is not one. Port of
 * `web/src/features/launchpad/lib/amounts.ts` `toAtomic` — form fields enter
 * the chain as whole base units / Q96 integers, never as floats.
 */
export function parseBaseUnits(
  value: string | bigint | null | undefined,
): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "bigint") return value;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Raw form strings plus the auction terms needed to compose a bid. */
export interface ComposeBidInput {
  /** Budget in currency base units (decimal integer string). */
  budget: string;
  /** Desired max price as a Q96 integer (decimal integer string). */
  maxPrice: string;
  /** Bid owner — the connected wallet; tokens and refunds settle there. */
  owner: string;
  /** The launch floor price (Q96) — the default previous-tick hint. */
  floorPriceQ96: bigint;
  /** The auction's tick spacing (Q96). */
  tickSpacingQ96: bigint;
  /** Current clearing price (Q96); `null` when unread (see `validateBid`). */
  clearingPriceQ96?: bigint | null;
  /** Auction `TOTAL_SUPPLY`; `null` when the record does not carry it. */
  supply?: bigint | null;
}

/** A composed bid plan (null on parse failure) plus inline field issues. */
export interface ComposedBid {
  plan: BidPlan | null;
  issues: BidIssue[];
}

/**
 * Compose the tick-snapped bid plan for the given form strings and surface
 * every issue the contract would reject, keyed to the offending field. The
 * previous-tick hint defaults to the launch floor (the auction's first
 * initialized tick) via `bidPlanWithDefaultHint` (`./evmCalls.ts`, the same
 * default web's `bidPlanWithDefaultHint` applies).
 */
export function composeBidPlan(input: ComposeBidInput): ComposedBid {
  const issues: BidIssue[] = [];
  const amount = parseBaseUnits(input.budget);
  const desired = parseBaseUnits(input.maxPrice);
  if (amount === null) {
    issues.push({
      field: "amount",
      severity: "error",
      message:
        "The budget must be a whole number in the currency's smallest units.",
    });
  } else if (amount <= 0n) {
    issues.push({
      field: "amount",
      severity: "error",
      message: AMOUNT_NOT_POSITIVE_MESSAGE,
    });
  }
  if (desired === null) {
    issues.push({
      field: "maxPrice",
      severity: "error",
      message: "The max price must be a whole number as a Q96 value.",
    });
  }
  if (amount !== null) {
    const wide = amountBoundsIssue(amount);
    if (wide) issues.push(wide);
  }
  if (amount === null || desired === null) {
    return { plan: null, issues };
  }
  // Snap up to the grid: a price between ticks reverts onchain
  // (TickPriceNotAtBoundary), and snapping up keeps the user's premium
  // rather than silently undercutting it.
  const maxPriceQ96 = snapMaxPriceToTick(desired, input.tickSpacingQ96);
  const plan = bidPlanWithDefaultHint(
    { maxPriceQ96, amount, owner: input.owner, hookData: "0x" },
    input.floorPriceQ96,
  );
  issues.push(
    ...validateBid(plan, {
      tickSpacingQ96: input.tickSpacingQ96,
      clearingPriceQ96: input.clearingPriceQ96 ?? null,
      supply: input.supply ?? null,
    }),
  );
  return { plan, issues };
}
