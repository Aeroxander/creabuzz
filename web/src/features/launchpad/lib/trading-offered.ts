/**
 * Whether this build shows the Trading card at all. Trading is off in every build that does not turn it on with two
 * explicit settings, both empty by default: a named market factory (`VITE_SECONDARY_MARKET_FACTORY`, the market to read)
 * and the trial switch (`VITE_TRADING_TRIAL=1`, a deliberate yes for this build). The hosted pilot image sets neither.
 *
 * Why two: a build with only a factory would show a "trading is not set up" card on every project, and a build with only
 * the switch would have no market to read; `lib/deploy-env.ts` refuses either half at build time. Trading does not depend
 * on raises: the contributor-only image offers none, and the trial build is contributor-only.
 *
 * A build that names a factory only for another network still shows the card, which says trading is not set up on the
 * project's network.
 *
 * Alias-free on purpose: `trading-offered.test.mjs` drives it under `node --test`.
 */

import { serverInvesting } from "../../../shared/lib/server-settings.ts";
import {
  type ChainEnv,
  secondaryMarketNamed,
  viteEnv,
} from "../chain-config.ts";

/**
 * Whether the trial switch is on: what the server says about investing when it says something (one setting for the
 * investing and trading screens, `shared/lib/server-settings.ts`), else the build's `VITE_TRADING_TRIAL`, true only for
 * the exact value `1` (anything else, an empty value included, leaves it off).
 */
export function tradingTrialOn(
  env: ChainEnv | undefined = viteEnv(),
  server: boolean | null = serverInvesting(),
): boolean {
  return server ?? env?.VITE_TRADING_TRIAL?.trim() === "1";
}

/** True when the Trading card should render: the switch is on and the build names a market to read. */
export function tradingOffered(
  env: ChainEnv | undefined = viteEnv(),
  server: boolean | null = serverInvesting(),
): boolean {
  return tradingTrialOn(env, server) && secondaryMarketNamed(env);
}
