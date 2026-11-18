import { defineConfig } from "@playwright/test";

// The built app served by `vite preview`; its sockets and server routes are the mock in tests/e2e/mock-relay.ts.
// One worker: the machine is shared. Build first (`pnpm build`); a preview already running on the port is reused.
const PORT = process.env.E2E_PORT ?? "4174";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Phone first: an iPhone-sized screen at twice the pixels, with touch.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: [
        "**/smoke.spec.ts",
        "**/join.spec.ts",
        "**/money.spec.ts",
        "**/a11y.spec.ts",
        "**/passkey.spec.ts",
      ],
    },
    { name: "screens", testMatch: ["**/screens.spec.ts"] },
  ],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
