/**
 * The currency a sale raises in: ETH or USDC.
 *
 * A launch record stores it as `currency`, an address; empty means the chain's
 * native coin (ETH). Everything that shows or converts money needs the symbol
 * and the decimals that go with it — ETH has 18, USDC has 6 — and until now the
 * whole wizard assumed USDC's six. This module is the one place that maps a
 * record's `currency` (plus its chain) to those, so no screen guesses.
 *
 * A record can also carry some other ERC-20 (older launches, hand-edited
 * records). That is kept as `custom` rather than coerced to one of the two
 * choices, so an edit never rewrites what the founder published (Review-Proven
 * Rule 1). Its decimals are assumed to be 6 like before; the founder is not
 * offered it as a new choice.
 *
 * Alias-free on purpose: `sale-currency.test.mjs` drives it under `node --test`.
 */

export type SaleCurrencyKind = "eth" | "usdc" | "custom";

export interface SaleCurrency {
  kind: SaleCurrencyKind;
  /** What amounts are labelled with. */
  symbol: string;
  decimals: number;
  /** The `currency` field to store: "" for ETH, else the token address (lowercase). */
  value: string;
}

export const ETH: SaleCurrency = {
  kind: "eth",
  symbol: "ETH",
  decimals: 18,
  value: "",
};

/**
 * Circle's native USDC on the chains the launchpad offers. A local chain has no
 * fixed USDC (the dev deploy lands wherever it lands), so it is supplied by the
 * caller — `VITE_LOCAL_USDC` in the app — and is absent by default.
 */
export const USDC_BY_CHAIN: Readonly<Record<number, string>> = {
  1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  11155111: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  84532: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** USDC's address on `chainId`, or null when this app does not know one. */
export function usdcAddress(
  chainId: number | string | null | undefined,
  localUsdc?: string | null,
): string | null {
  const id = typeof chainId === "string" ? Number(chainId.trim()) : chainId;
  if (id === 31337 || id === 1776411) {
    const local = (localUsdc ?? "").trim();
    return ADDRESS_RE.test(local) ? local.toLowerCase() : null;
  }
  return id !== null && id !== undefined ? (USDC_BY_CHAIN[id] ?? null) : null;
}

export function usdcCurrency(address: string): SaleCurrency {
  return {
    kind: "usdc",
    symbol: "USDC",
    decimals: 6,
    value: address.toLowerCase(),
  };
}

/**
 * The sale currency a record's `currency` field means on its chain. Empty (or
 * the zero address) is ETH; the chain's USDC is USDC; any other address is
 * `custom`.
 */
export function saleCurrencyFor(
  currency: string | null | undefined,
  chainId: number | string | null | undefined,
  localUsdc?: string | null,
): SaleCurrency {
  const raw = (currency ?? "").trim();
  if (raw === "" || raw.toLowerCase() === ZERO) return ETH;
  const address = raw.toLowerCase();
  if (address === usdcAddress(chainId, localUsdc)) return usdcCurrency(address);
  return {
    kind: "custom",
    symbol: ADDRESS_RE.test(raw) ? "tokens" : "units",
    decimals: 6,
    value: address,
  };
}

/**
 * The choices offered for a new sale on `chainId`. ETH is always there; USDC
 * only where its address is known, so the control never offers a currency the
 * app cannot point the auction at.
 */
export function currencyChoices(
  chainId: number | string | null | undefined,
  localUsdc?: string | null,
): SaleCurrency[] {
  const usdc = usdcAddress(chainId, localUsdc);
  return usdc ? [usdcCurrency(usdc), ETH] : [ETH];
}

/**
 * `formatQ96PerToken` options for a sale currency: its decimals, and for ETH the
 * unit printed after the figure (a price in USDC keeps its `$` prefix).
 */
export function priceFormat(currency: SaleCurrency): {
  currencyDecimals: number;
  unit?: string;
} {
  return currency.kind === "eth"
    ? { currencyDecimals: currency.decimals, unit: "ETH" }
    : { currencyDecimals: currency.decimals };
}

/** One "budget unit" to show a bidder what money buys: $1,000 or 1 ETH, atomic. */
export function sampleBudget(currency: SaleCurrency): {
  atomic: bigint;
  label: string;
} {
  return currency.kind === "eth"
    ? { atomic: 10n ** 18n, label: "1 ETH" }
    : { atomic: 1_000n * 10n ** BigInt(currency.decimals), label: "$1,000" };
}
