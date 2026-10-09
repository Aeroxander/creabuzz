import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: [
        "**/smoke.spec.ts",
        "**/launchpad.spec.ts",
        "**/voting-allocation.spec.ts",
        "**/launchpad-auction.spec.ts",
        "**/launchpad-dao-launch.spec.ts",
        "**/launchpad-work.spec.ts",
        "**/launchpad-milestone.spec.ts",
        "**/launchpad-market.spec.ts",
        "**/launchpad-decisions.spec.ts",
        "**/launchpad-journey.spec.ts",
        "**/launchpad-paid-work.spec.ts",
        "**/launchpad-market-journey.spec.ts",
        "**/social-cashtag.spec.ts",
        "**/funding-status.spec.ts",
        // Overlay stacking: the header's blur must not trap popups behind page
        // content. One assertion, but it is the whole bug.
        "**/stack-check.spec.ts",
        "**/feed.spec.ts",
        "**/responsive.spec.ts",
        "**/responsive-surfaces.spec.ts",
        "**/a11y.spec.ts",
        "**/sandbox.spec.ts",
        "**/multi-user.spec.ts",
        "**/browser-agent.spec.ts",
        "**/passkey.spec.ts",
        "**/screenshots.spec.ts",
        "**/usernames.spec.ts",
        "**/org-chart.spec.ts",
        "**/projects.spec.ts",
        "**/discover.spec.ts",
        "**/signing-recovery.spec.ts",
        "**/task-planning.spec.ts",
        "**/portfolio.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
        // Escape hatch for machines whose Chromium is older than the build the
        // pinned Playwright wants (never `playwright install` for this).
        ...(process.env.PW_CHROMIUM_PATH
          ? {
              launchOptions: {
                executablePath: process.env.PW_CHROMIUM_PATH,
                args: ["--no-sandbox"],
              },
            }
          : {}),
      },
    },
    {
      // Opt-in only: gated on E2E_SPONSORED_OPS=1 + ZERODEV_API_KEY and NEVER
      // part of the default smoke — it spends real sponsorship (see
      // tests/e2e/sponsored-op.spec.ts for the runbook).
      name: "sponsored-op",
      testMatch: ["**/sponsored-op.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort --host 127.0.0.1",
    cwd: ".",
    reuseExistingServer: !process.env.CI,
    url: "http://127.0.0.1:4173",
  },
});
