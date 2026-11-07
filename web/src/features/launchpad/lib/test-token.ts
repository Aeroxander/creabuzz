/**
 * The free test token a trial build offers on its Trading card (`VITE_TEST_QUOTE_TOKENS`): a token anyone can make more
 * of, worth nothing, so a person can try a weekly sale without money. The action shows only when a market's own price
 * token is the very token this build names for that network, so a market priced in anything else never shows it.
 *
 * Alias-free on purpose: `test-token.test.mjs` drives it under `node --test`.
 */

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";

import { type ChainEnv, testQuoteToken, viteEnv } from "../chain-config.ts";

/** What one press makes, in whole tokens. The token itself allows up to 10,000 in one call. */
export const MINT_TEST_TOKENS_WHOLE = 1_000n;

export const GET_TEST_TOKENS_LABEL = "Get test tokens";

export const TEST_TOKEN_NOTE =
  "This token is free and worth nothing: anyone can get more of it, so a price in it proves nothing. It is here only to try trading.";

/** Whether `quoteToken`, a market's price token, is the free test token this build names for `chainId`. */
export function isTestQuote(
  quoteToken: string,
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): boolean {
  const named = testQuoteToken(chainId, env);
  return named !== null && quoteToken.trim().toLowerCase() === named;
}

/** `mint(to, 1,000)` in the token's own units: the call that hands the signed-in account its free tokens. */
export function encodeMintTestTokens(to: string, decimals: number): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("invalid address");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error("invalid token units");
  return encodeFunctionData(
    "mint(address,uint256)",
    ["address", "uint256"],
    [to, MINT_TEST_TOKENS_WHOLE * 10n ** BigInt(decimals)],
  );
}
