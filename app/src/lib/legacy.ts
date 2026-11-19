/**
 * The ONE build flag behind which the screens of the old money design live: the stages (Solo, Backed, Team, Council,
 * Open), backing rounds, the auction, the market and its pool, handing Shares back, the earlier backers' page, and the
 * Team screens that were written for them. Off by default: with it off nothing of them is reachable (no route, no
 * entry point, not even their code is loaded), and no test depends on a version 1 record being published.
 *
 * Switch it on for a build with `VITE_CREATON_LEGACY_SCREENS=1`. The screens then read record version 1 through the
 * `legacy/` glue; the server no longer publishes it, so this exists to keep the work in the tree, not to be shipped.
 */
export function legacyScreensOn(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return env.VITE_CREATON_LEGACY_SCREENS === "1";
}
