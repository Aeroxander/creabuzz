import { defineConfig } from "@playwright/test";

/**
 * Step 1 joined up (`scripts/pot-full-loop.sh`): the real relay with its chain reader on a local chain serves the app's own
 * build; one journey in Chromium walks a project from its start to a Take out. Nothing is mocked. Phone first, as every
 * other run: 390x844 with touch, one worker.
 */
export default defineConfig({
  testDir: "./tests/e2e-pot-full",
  testMatch: ["**/*.spec.ts"],
  timeout: 600_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/playwright-pot-full",
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
