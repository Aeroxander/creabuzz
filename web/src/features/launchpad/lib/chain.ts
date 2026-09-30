/**
 * Import path for files inside `lib/` (`./chain`), pointing at the canonical
 * chain seam one level up: `web/src/features/launchpad/chain.ts`.
 *
 * One module, two paths — `../chain` from `ui/`, `./chain` from `lib/` — so
 * the RPC endpoint helpers and the `CHAIN_PRESETS` picker list are never
 * duplicated. Nothing is defined here; re-export it all.
 */
export * from "../chain";
