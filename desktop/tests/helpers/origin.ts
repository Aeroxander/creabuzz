/**
 * Origin of the current e2e run's static server.
 *
 * `scripts/e2e-run.mjs` exports `BUZZ_E2E_PORT` before Playwright starts, so
 * every worker resolves the same per-run origin. Bare `playwright test` runs
 * without the wrapper fall back to the legacy shared port 4173.
 *
 * Use this instead of hardcoding `http://127.0.0.1:4173` anywhere a spec
 * needs the served origin (clipboard permission grants, asset URLs, …).
 */
export function e2eOrigin(): string {
  return `http://127.0.0.1:${process.env.BUZZ_E2E_PORT ?? "4173"}`;
}

/** Absolute URL for a path on the current run's server. */
export function e2eUrl(pathname: string): string {
  return `${e2eOrigin()}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}
