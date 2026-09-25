/**
 * Human-readable money and time for the launchpad.
 *
 * Everything on chain is an integer in the smallest unit of something, and the
 * client used to print those integers raw: the raise panel showed
 * `1000000000 / 1000000000`, which is a number nobody can act on. This module is
 * the single place that turns atomic units into something a person can read, and
 * it says "unknown" rather than inventing a figure when it has none.
 *
 * Alias-free on purpose: `amounts.test.mjs` drives it under `node --test`.
 */

/** Currency the launchpad raises in by default (USDC on Base). */
export const USDC_DECIMALS = 6;

function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A bigint from a decimal string, or null when the input is not one. */
export function toAtomic(
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

/**
 * Format atomic units with the currency's decimals.
 *
 * Whole amounts lose the decimal tail (`300,000 USDC`, not
 * `300000.000000 USDC`); fractional amounts keep enough digits to be exact.
 */
export function formatAtomic(
  value: string | bigint | null | undefined,
  decimals = USDC_DECIMALS,
  options: { symbol?: string; maxFractionDigits?: number } = {},
): string {
  const atomic = toAtomic(value);
  if (atomic === null) return "—";
  const negative = atomic < 0n;
  const maxFraction = options.maxFractionDigits ?? decimals;
  const scale = 10n ** BigInt(decimals);
  // Round at the digit we are about to drop, rather than truncating: a Q96 price
  // that is a hair under a dollar read as "$0.999999".
  const kept = 10n ** BigInt(Math.max(0, decimals - maxFraction));
  let magnitude = negative ? -atomic : atomic;
  if (kept > 1n) magnitude += kept / 2n;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const symbol = options.symbol ? ` ${options.symbol}` : "";

  if (fraction === 0n) {
    return `${negative ? "-" : ""}${groupThousands(whole.toString())}${symbol}`;
  }
  const digits = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  if (digits.length === 0) {
    return `${negative ? "-" : ""}${groupThousands(whole.toString())}${symbol}`;
  }
  return `${negative ? "-" : ""}${groupThousands(whole.toString())}.${digits}${symbol}`;
}

/** Money as USD, with the currency symbol in front. */
export function formatUsd(
  value: string | bigint | null | undefined,
  decimals = USDC_DECIMALS,
): string {
  const formatted = formatAtomic(value, decimals, { maxFractionDigits: 2 });
  return formatted === "—" ? formatted : `$${formatted}`;
}

/**
 * A price per whole token, from a Q96 price and the two decimal scales.
 *
 * Q96 prices are currency-smallest-units per token-smallest-unit, so the display
 * value needs both decimals to mean anything.
 */
export function formatQ96PerToken(
  floorPriceQ96: string | bigint | null | undefined,
  options: {
    tokenDecimals?: number;
    currencyDecimals?: number;
    symbol?: string;
  } = {},
): string {
  const q96 = toAtomic(floorPriceQ96);
  if (q96 === null || q96 === 0n) return "—";
  const tokenDecimals = options.tokenDecimals ?? 18;
  const currencyDecimals = options.currencyDecimals ?? USDC_DECIMALS;
  // currency smallest units per whole token
  const perToken = (q96 * 10n ** BigInt(tokenDecimals)) / (1n << 96n);
  const prefix = options.symbol ? `${options.symbol}` : "$";
  // Precision follows magnitude: a dollar price reads as "$1", a sub-cent one
  // keeps enough digits not to round to zero. Q96 arithmetic loses a hair, and
  // "rounded at the displayed digit" would otherwise print "$0.999999".
  const scale = 10n ** BigInt(currencyDecimals);
  const maxFraction =
    perToken >= scale / 100n ? 2 : perToken >= scale / 1_000_000n ? 4 : 6;
  return `${prefix}${formatAtomic(perToken, currencyDecimals, { maxFractionDigits: maxFraction })}`;
}

/** A block count as a duration, at a chain's block time. */
export function formatBlocks(
  blocks: string | number | bigint | null | undefined,
  blocksPerDay = 43_200,
): string {
  const count =
    typeof blocks === "bigint" ? Number(blocks) : Number(blocks ?? 0);
  if (!Number.isFinite(count) || count <= 0) return "—";
  const days = count / blocksPerDay;
  if (days >= 1) {
    const rounded = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
    return `${rounded} day${rounded === 1 ? "" : "s"}`;
  }
  const hours = days * 24;
  if (hours >= 1) {
    const rounded = Math.round(hours * 10) / 10;
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(hours * 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** How far along a raise is, as a percentage, or null when the goal is unknown. */
export function percentOfGoal(
  raised: string | bigint | null | undefined,
  goal: string | bigint | null | undefined,
): number | null {
  const raisedAtomic = toAtomic(raised);
  const goalAtomic = toAtomic(goal);
  if (raisedAtomic === null || goalAtomic === null || goalAtomic === 0n) {
    return null;
  }
  return Number((raisedAtomic * 10_000n) / goalAtomic) / 100;
}

/** What still has to be raised to graduate, or null when it is already met. */
export function remainingToGraduate(
  raised: string | bigint | null | undefined,
  goal: string | bigint | null | undefined,
): bigint | null {
  const raisedAtomic = toAtomic(raised);
  const goalAtomic = toAtomic(goal);
  if (raisedAtomic === null || goalAtomic === null) return null;
  const remaining = goalAtomic - raisedAtomic;
  return remaining > 0n ? remaining : null;
}

/**
 * What happens when the auction ends, either way.
 *
 * A buyer is being asked for money; the two outcomes have to be readable before
 * they bid, not after.
 */
export const SETTLEMENT_TERMS = [
  {
    outcome: "If the threshold is met",
    detail:
      "The sale clears at one uniform price, everyone pays that price for their fill, liquidity is seeded from the clearing price and the rest of the raise goes to the treasury. Tokens are claimable after the claim block.",
  },
  {
    outcome: "If the threshold is missed",
    detail:
      "No sale happens and every bid is refundable in full; no entity is formed and no tokens are issued. Nothing is lost but the transaction fees.",
  },
  {
    outcome: "Before either",
    detail:
      "Bids are committed on chain and cannot be withdrawn early. Your budget is your maximum: you pay the clearing price for whatever fill you get, not your maximum price.",
  },
] as const;

/**
 * Money at the precision people use. Atomic units go to six decimals, which is
 * noise on a raise figure; two decimals and rounding is what a treasury screen
 * shows, so a threshold of 299999.999998 reads as 300,000.
 */
export function formatMoney(value: string | bigint | null | undefined): string {
  return formatAtomic(value, USDC_DECIMALS, {
    symbol: "USDC",
    maxFractionDigits: 2,
  });
}
