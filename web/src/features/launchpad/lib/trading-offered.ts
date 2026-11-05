/**
 * Whether this build shows the Trading card at all. Trading stays off wherever the build does not turn it on: the
 * contributor-only hosted image offers none (it also names no market factory), and a build with no factory has no
 * market to read. A build that names a factory only for another network still shows the card, which says trading is
 * not set up on the project's network.
 *
 * Alias-free on purpose: `trading-offered.test.mjs` drives it under `node --test`.
 */

import {
  type ChainEnv,
  secondaryMarketNamed,
  viteEnv,
} from "../chain-config.ts";
import { raisesOffered } from "./raises-offered.ts";

/** True when the Trading card should render. */
export function tradingOffered(env: ChainEnv | undefined = viteEnv()): boolean {
  return raisesOffered(env) && secondaryMarketNamed(env);
}
