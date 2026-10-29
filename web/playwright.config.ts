import { defineConfig, devices } from "@playwright/test";

// The preview's port, and optionally a build folder of its own: lets the mocked specs run beside a journey script that
// holds :4173 and web/dist. Specs that name :4173 themselves need the default.
const PORT = process.env.E2E_PORT ?? "4173";
const DIST = process.env.E2E_DIST;

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
    baseURL: `http://127.0.0.1:${PORT}`,
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
        "**/launchpad-challenge.spec.ts",
        "**/launchpad-work.spec.ts",
        "**/launchpad-milestone.spec.ts",
        "**/launchpad-record.spec.ts",
        "**/launchpad-presets.spec.ts",
        "**/community-create.spec.ts",
        "**/community-access.spec.ts",
        "**/report.spec.ts",
        "**/chat-removal.spec.ts",
        // DM threads only under Messages; the server's room notes as sentences.
        "**/room-notes.spec.ts",
        "**/social-safety.spec.ts",
        "**/launchpad-empty.spec.ts",
        "**/social-mention.spec.ts",
        "**/invite-join.spec.ts",
        "**/markets.spec.ts",
        "**/markets-prices.spec.ts",
        "**/error-report.spec.ts",
        "**/launchpad-market.spec.ts",
        "**/launchpad-decisions.spec.ts",
        "**/launchpad-discussion.spec.ts",
        "**/launchpad-journey.spec.ts",
        "**/launchpad-paid-work.spec.ts",
        "**/contributor-project.spec.ts",
        "**/contributor-journey.spec.ts",
        "**/post-bounty-journey.spec.ts",
        "**/rounds-journey.spec.ts",
        "**/launchpad-market-journey.spec.ts",
        "**/social-cashtag.spec.ts",
        "**/funding-status.spec.ts",
        // Overlay stacking: the header's blur must not trap popups behind page
        // content. One assertion, but it is the whole bug.
        "**/stack-check.spec.ts",
        "**/feed.spec.ts",
        "**/dao-os.spec.ts",
        "**/responsive.spec.ts",
        "**/responsive-surfaces.spec.ts",
        "**/a11y.spec.ts",
        "**/a11y-pilot.spec.ts",
        "**/a11y-phone.spec.ts",
        "**/sandbox.spec.ts",
        "**/multi-user.spec.ts",
        "**/browser-agent.spec.ts",
        "**/passkey.spec.ts",
        "**/payment-wallet.spec.ts",
        "**/screenshots.spec.ts",
        "**/usernames.spec.ts",
        "**/org-chart.spec.ts",
        "**/org-setup.spec.ts",
        "**/polling-bounds.spec.ts",
        "**/first-run.spec.ts",
        "**/start-project.spec.ts",
        "**/helpers.spec.ts",
        "**/board.spec.ts",
        "**/board-moderation.spec.ts",
        "**/board-reports.spec.ts",
        "**/mute-everywhere.spec.ts",
        "**/unread-rooms.spec.ts",
        "**/access-refused.spec.ts",
        "**/live-scope.spec.ts",
        "**/home-timeline.spec.ts",
        "**/social-mvp.spec.ts",
        "**/home-checklist.spec.ts",
        "**/projects.spec.ts",
        "**/discover.spec.ts",
        "**/signing-recovery.spec.ts",
        "**/task-planning.spec.ts",
        "**/board-ideas.spec.ts",
        "**/launchpad-ip-record.spec.ts",
        "**/launchpad-revenue-pledge.spec.ts",
        "**/portfolio.spec.ts",
        "**/tour.spec.ts",
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
    {
      // Needs a build with a chain configured (VITE_ZERODEV_CHAIN_ID, VITE_CHAIN_RPC_URL), so it cannot share the default
      // smoke build: run it with scripts/web-passkey-wallet-e2e.sh.
      name: "passkey-wallet",
      testMatch: ["**/passkey-wallet.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      // A contributor project from passkey accounts on a Sepolia fork (D139), with a build of its own: run it with
      // scripts/web-passkey-contributor-e2e.sh.
      name: "passkey-contributor",
      testMatch: ["**/passkey-contributor.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort --host 127.0.0.1${DIST ? ` --outDir ${DIST}` : ""}`,
    cwd: ".",
    reuseExistingServer: !process.env.CI,
    url: `http://127.0.0.1:${PORT}`,
  },
});
