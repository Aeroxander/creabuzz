/**
 * Whether this build shows remixes (N11): "Built on" and "What you ask in return" on the start form, and the card on a
 * project's overview. The hosted pilot leaves out every optional feature (PILOT-RUNBOOK), so a contributor-only build
 * shows none of it. Records that already name what they build on keep those words; only the screens are left out.
 *
 * Alias-free on purpose: `remixes-offered.test.mjs` drives it under `node --test`.
 */

import { type ChainEnv, viteEnv } from "../chain-config.ts";
import { raisesOffered } from "./raises-offered.ts";

/** False in a contributor-only build. */
export function remixesOffered(env: ChainEnv | undefined = viteEnv()): boolean {
  return raisesOffered(env);
}
