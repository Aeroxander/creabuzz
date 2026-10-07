import { defineConfig, devices } from "@playwright/test";

/**
 * The whole-project simulation (`just simulate`, plan §9): a scripted story
 * played in the app, one command, one timeline report.
 *
 * `testMatch` is `.spec.ts` only on purpose — `tests/simulate/` also holds the
 * runner's own unit tests (`*.test.mjs`, run by `pnpm test`), which are not
 * browser tests and must not be picked up here.
 */
export default defineConfig({
  testDir: "./tests/simulate",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort --host 127.0.0.1",
    cwd: ".",
    reuseExistingServer: !process.env.CI,
    url: "http://127.0.0.1:4173",
  },
});
