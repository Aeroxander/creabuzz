import { defineConfig, devices } from "@playwright/test";

/**
 * Runs the web client against a **real relay**.
 *
 * Unlike the default suite (which mocks the relay), this needs a relay serving
 * the built client, with a seeded community and the documented dev test
 * identity. See `web/tests/e2e-real/README.md` for the setup, and
 * `pnpm test:e2e:real`.
 */
export default defineConfig({
  testDir: "./tests/e2e-real",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BUZZ_REAL_RELAY_URL ?? "http://localhost:3199",
    ...devices["Desktop Chrome"],
  },
});
