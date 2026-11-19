/**
 * Whether the app under test was built with the legacy-screens flag (`VITE_CREATON_LEGACY_SCREENS=1`, see
 * `src/lib/legacy.ts`). The specs of the old money design (stages, rounds, the auction, the market, Team's Pair, the earlier
 * backers, receipts) need that build and the version 1 records their worlds serve; without it they are skipped, never
 * failed. Build with the flag, then run with the same variable set, to run them: they are kept, not deleted.
 */
export const LEGACY_BUILD = process.env.VITE_CREATON_LEGACY_SCREENS === "1";
export const LEGACY_WHY =
  "needs a build with VITE_CREATON_LEGACY_SCREENS=1 (the old money design is behind that flag)";
