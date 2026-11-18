/**
 * Whether this build shows investing at all: the Backing block on a project, its cards in Home's feed, positions under
 * You, and the pool-aware setup of Shares. It is ONE switch, off by default: `VITE_INVESTING=1`, together with the pool
 * factory the build names (`VITE_BACKING_POOL_FACTORY`). With the switch off nothing money-related changes from what the
 * build showed before, in every build, the contributor-only one included.
 *
 * The server may say so too (`BUZZ_INVESTING`, in its information document): when it does, that wins over the build's
 * switch, in both directions, with no rebuild. When it says nothing the build's switch is the answer.
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

import { serverInvesting } from "../../../shared/lib/server-settings.ts";
import {
  backingPoolFactory,
  type ChainEnv,
  namesAnyAddress,
  viteEnv,
} from "../chain-config.ts";

/**
 * Whether the switch is on: what the server says when it says something (`shared/lib/server-settings.ts`, from its
 * `BUZZ_INVESTING`), else the build's own `VITE_INVESTING`, true only for the exact value `1` (anything else, an empty
 * value included, leaves it off). The server's word is for the switch only: the addresses the screens read still come
 * from the build, so a server saying yes to a build that names no pool factory shows nothing.
 */
export function investingSwitchOn(
  env: ChainEnv | undefined = viteEnv(),
  server: boolean | null = serverInvesting(),
): boolean {
  return server ?? env?.VITE_INVESTING?.trim() === "1";
}

/** True when every investing surface may render: the switch is on and the build names a pool factory somewhere. */
export function investingOffered(
  env: ChainEnv | undefined = viteEnv(),
  server: boolean | null = serverInvesting(),
): boolean {
  return (
    investingSwitchOn(env, server) &&
    namesAnyAddress(env?.VITE_BACKING_POOL_FACTORY)
  );
}

/** The pool factory for a project's own network, when investing is on; null when it is off or names none for that network. */
export function investingFactoryFor(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
  server: boolean | null = serverInvesting(),
): string | null {
  return investingOffered(env, server)
    ? backingPoolFactory(chainId, env)
    : null;
}
