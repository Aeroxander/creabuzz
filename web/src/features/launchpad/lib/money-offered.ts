/**
 * Whether this build has anything to do with money or Shares at all.
 *
 * A server whose build offers no sales, keeps investing off and names no contributor kit cannot make Shares, hold them
 * or pay anyone. Cards that only make sense with one of those (the Shares someone holds, a payment wallet, a score
 * beside a record that says nobody is scored) stay off its pages. A build with any one of the three shows them as
 * before. Legal text is not gated by this.
 *
 * Alias-free on purpose: `money-offered.test.mjs` drives it under `node --test`.
 */

import { type ChainEnv, namesAnyAddress, viteEnv } from "../chain-config.ts";
import { investingOffered } from "./investing-offered.ts";
import { raisesOffered } from "./raises-offered.ts";

/** True when the build names a contributor kit on some network: the one thing that can set up Shares for helpers. */
export function contributorKitNamed(
  env: ChainEnv | undefined = viteEnv(),
): boolean {
  return (
    namesAnyAddress(env?.VITE_CONTRIBUTOR_KITS) ||
    (investingOffered(env) && namesAnyAddress(env?.VITE_CONTRIBUTOR_KIT_V3))
  );
}

/** False only for a build with no sales, investing off and no contributor kit: a server with no money on it. */
export function moneyOffered(env: ChainEnv | undefined = viteEnv()): boolean {
  return (
    raisesOffered(env) || investingOffered(env) || contributorKitNamed(env)
  );
}
