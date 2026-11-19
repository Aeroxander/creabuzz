import { defineConfig } from "@playwright/test";

// The phone path in a real browser: the app built with the phone settings (scripts/phone-e2e.sh) served by `vite preview`,
// a local chain and a stand-in bundler started by the spec. One worker; the machine is shared.
const PORT = process.env.E2E_PORT ?? "4174";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/phone-back.spec.ts", "**/phone-choice.spec.ts"],
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/playwright-phone",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm exec vite preview --outDir node_modules/.phone-dist --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
