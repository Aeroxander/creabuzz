/**
 * Which assets an exit pays out, and how their amounts read.
 *
 * An exit burns the holder's Shares once and pays only the assets it names. If the sale's currency (USDC, usually) is
 * left off the list, the Shares are gone and that part of the treasury can no longer be claimed with them. So the list
 * is only ever built from a currency that was actually read: while it is being read, or if the read failed or came back
 * as nonsense, there is no list, and no exit.
 *
 * Pure and alias-free apart from the shared formatter: `exit-tokens.test.mjs` drives it under `node --test`.
 */

import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";

/** The zero address: how an exit names ETH. */
const ETH = "0x0000000000000000000000000000000000000000";

/**
 * The currency an auction's `currency()` answers with: one 32-byte word holding an address. Anything else (a short reply,
 * a reply with stray bytes above the address, a non-contract's empty answer) is not an answer, and throws.
 */
export function decodeCurrencyAnswer(raw: string): string {
  const body = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(body) || !/^0{24}/.test(body)) {
    throw new Error(
      "The sale did not say what currency it was paid in, so leaving is switched off until it does.",
    );
  }
  return `0x${body.slice(24).toLowerCase()}`;
}

export type ExitTokens =
  | { status: "ready"; tokens: string[] }
  | { status: "reading" }
  | { status: "failed"; message: string };

/**
 * The assets an exit would pay. A project with a sale contract needs that contract's currency read first. One without
 * (a DAO bound some other way) falls back to the currency its launch record names, if it names one: the treasury still
 * holds that money, and leaving it off would forfeit it. Only a project that names no currency at all pays ETH alone.
 */
export function exitTokensFor(input: {
  hasAuction: boolean;
  /** The currency address the launch record names (null for ETH or none). Used when there is no sale contract to ask. */
  recordCurrency?: string | null;
  currency:
    | { state: "pending" }
    | { state: "error"; message: string }
    | { state: "success"; address: string };
}): ExitTokens {
  if (!input.hasAuction) {
    const recorded = (input.recordCurrency ?? "").toLowerCase();
    const named = /^0x[0-9a-f]{40}$/.test(recorded) && recorded !== ETH;
    return { status: "ready", tokens: named ? [ETH, recorded].sort() : [ETH] };
  }
  const { currency } = input;
  if (currency.state === "pending") return { status: "reading" };
  if (currency.state === "error") {
    return { status: "failed", message: currency.message };
  }
  const address = currency.address.toLowerCase();
  return {
    status: "ready",
    tokens: address === ETH ? [ETH] : [ETH, address].sort(),
  };
}

/** A token's name and decimals as read; null where the token did not say. */
export interface TokenInfo {
  symbol: string | null;
  decimals: number | null;
}

/**
 * An amount of a token as people read it. Where the token did not say how many decimals it has, the number is shown as
 * it is on the chain, labelled raw: guessing a scale would print a six-decimal token a trillion times too small.
 */
export function formatTokenAmount(value: bigint, info: TokenInfo): string {
  if (info.decimals === null) {
    return `${value.toString()} raw units${info.symbol ? ` of ${info.symbol}` : ""}`;
  }
  return `${formatUnits(value, info.decimals, info.decimals > 6 ? 4 : 2)} ${info.symbol ?? "tokens"}`;
}
