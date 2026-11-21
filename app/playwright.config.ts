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
        "**/a11y.spec.ts",
        "**/passkey.spec.ts",
        "**/manager.spec.ts",
        // Search and topics, saved posts, hidden people and reports (the mock server, 360 wide).
        "**/search.spec.ts",
        "**/bookmarks.spec.ts",
        "**/mutes.spec.ts",
        "**/report.spec.ts",
        // A project's brain: the notes read from a real git repository, and the offer in Start (the mock server, 360 wide).
        "**/brain.spec.ts",
        // Pictures in posts, editing and deleting, reposts and quotes, message servers and the recovery key (the mock server).
        "**/pictures.spec.ts",
        "**/messages-key.spec.ts",
        // The pot contracts on a real local chain (they start their own anvil; skipped without one).
        "**/pot-*.spec.ts",
      ],
    },
    {
      name: "screens",
      testMatch: ["**/screens.spec.ts"],
    },
  ],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
