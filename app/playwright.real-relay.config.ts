import { defineConfig } from "@playwright/test";

/**
 * The new app against a REAL server (`scripts/app-real-loop-e2e.sh`): the relay serves the app's own build
 * (`BUZZ_WEB_DIR` = the app's dist) on a scratch database, with the hosted terms, privacy note and age box on. Nothing
 * is mocked. Phone first, as the mocked runs: 390x844 with touch, one worker.
 */
export default defineConfig({
  testDir: "./tests/e2e-real",
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/playwright-real",
  use: {
    baseURL: process.env.BUZZ_REAL_RELAY_URL ?? "http://localhost:3199",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ...(process.env.PW_CHROMIUM_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PW_CHROMIUM_PATH,
            args: [
              "--no-sandbox",
              ...(process.env.PW_CHROMIUM_EXTRA_ARGS?.split(" ") ?? []),
            ],
          },
        }
      : {}),
  },
});
