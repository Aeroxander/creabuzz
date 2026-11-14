/**
 * Whether this build shows investing at all: the Backing block on a project, its cards in Home's feed, positions under
 * You, and the pool-aware setup of Shares. It is ONE switch, off by default: `VITE_INVESTING=1`, together with the pool
 * factory the build names (`VITE_BACKING_POOL_FACTORY`). With the switch off nothing money-related changes from what the
 * build showed before, in every build, the contributor-only one included.
 *
 * With the switch on, the contributor-only build shows these surfaces and no others: raises, the weekly sale and the rest
 * of what that build hides stay hidden (`raises-offered.ts`).
 *
 * Why two settings, not one: a build with only the switch would have no pool to read, and a build with only a factory
 * would carry an address nobody asked to use. `lib/deploy-env.ts` refuses either half, and an address that is missing for
 * the chain, at build time.
 *
 * Alias-free on purpose: `investing-offered.test.mjs` drives it under `node --test`.
 */

import {
  backingPoolFactory,
  type ChainEnv,
  namesAnyAddress,
  viteEnv,
} from "../chain-config.ts";

/** True only for the exact value `1`: anything else, an empty value included, leaves the switch off. */
export function investingSwitchOn(
  env: ChainEnv | undefined = viteEnv(),
): boolean {
  return env?.VITE_INVESTING?.trim() === "1";
}

/** True when every investing surface may render: the switch is on and the build names a pool factory somewhere. */
export function investingOffered(
  env: ChainEnv | undefined = viteEnv(),
): boolean {
  return (
    investingSwitchOn(env) && namesAnyAddress(env?.VITE_BACKING_POOL_FACTORY)
  );
}

/** The pool factory for a project's own network, when investing is on; null when it is off or names none for that network. */
export function investingFactoryFor(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return investingOffered(env) ? backingPoolFactory(chainId, env) : null;
}
