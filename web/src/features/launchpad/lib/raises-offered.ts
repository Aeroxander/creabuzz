/**
 * Whether this build offers raises at all. The hosted image is contributor-only (its Dockerfile sets
 * VITE_CONTRIBUTOR_ONLY=1 and takes no raise kit), so every place that starts a sale hides itself there instead of
 * leading to a sale that cannot be launched; raises already listed on the server stay readable. Every other build (a
 * developer's, the test builds) offers them as before, with or without a kit to launch one.
 *
 * Alias-free on purpose: `raises-offered.test.mjs` drives it under `node --test`.
 */

import { type ChainEnv, viteEnv } from "../chain-config.ts";

/** False in a contributor-only build. */
export function raisesOffered(env: ChainEnv | undefined = viteEnv()): boolean {
  return env?.VITE_CONTRIBUTOR_ONLY?.trim() !== "1";
}
