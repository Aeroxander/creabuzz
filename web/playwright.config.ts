import { defineConfig, devices } from "@playwright/test";

// The preview's port, and optionally a build folder of its own: lets the mocked specs run beside a journey script that
// holds :4173 and web/dist. Specs take the port from tests/e2e/mock-relay.ts (PREVIEW_PORT, COMMUNITY_HOST).
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
        "**/launchpad-dao-launch.spec.ts",
        "**/launchpad-challenge.spec.ts",
        "**/launchpad-work.spec.ts",
        "**/launchpad-milestone.spec.ts",
        "**/launchpad-record.spec.ts",
        "**/launchpad-presets.spec.ts",
        "**/community-create.spec.ts",
        "**/community-access.spec.ts",
        "**/channel-edit.spec.ts",
        // The community screen audit's fixes (2026-10-30).
        "**/community-shouldfix.spec.ts",
        // `/c/<another host>` shows that community's card, never the connected server's rooms under its name.
        "**/community-other-host.spec.ts",
        "**/report.spec.ts",
        "**/chat-removal.spec.ts",
        // DM threads only under Messages; the server's room notes as sentences.
        "**/room-notes.spec.ts",
        "**/social-safety.spec.ts",
        // A post's page reads its thread on two sockets at most, however deep the reply.
        "**/social-thread-load.spec.ts",
        // The social audit's should-fix items (D143), one spec per area.
        "**/social-shouldfix-*.spec.ts",
        // The contributor-project audit's fixes (D144), one spec per area.
        "**/launchpad-shouldfix-*.spec.ts",
        "**/launchpad-empty.spec.ts",
        "**/social-mention.spec.ts",
        // A mention picked in a room's composer, and read failures said as failures (not as "nothing here").
        "**/room-composer-mentions.spec.ts",
        "**/social-read-errors.spec.ts",
        "**/invite-join.spec.ts",
        "**/error-report.spec.ts",
        "**/launchpad-decisions.spec.ts",
        "**/launchpad-discussion.spec.ts",
        "**/launchpad-journey.spec.ts",
        "**/launchpad-paid-work.spec.ts",
        "**/contributor-project.spec.ts",
        "**/contributor-journey.spec.ts",
        "**/post-bounty-journey.spec.ts",
        "**/secondary-trading.spec.ts",
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
        "**/passkey-safety.spec.ts",
        // The passkey screens in a production build: no dev stand-in, real WebAuthn, dialogs that hold focus.
        "**/passkey-production.spec.ts",
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
        "**/terms-again.spec.ts",
        "**/signup-terms-paths.spec.ts",
        "**/home-checklist.spec.ts",
        "**/projects.spec.ts",
        "**/repo-refs.spec.ts",
        "**/discover.spec.ts",
        "**/signing-recovery.spec.ts",
        "**/task-planning.spec.ts",
        "**/board-ideas.spec.ts",
        "**/launchpad-ip-record.spec.ts",
        "**/launchpad-revenue-pledge.spec.ts",
        "**/portfolio.spec.ts",
        "**/tour.spec.ts",
        // Phase A review: the project front page as one story (one next action, honest window dates, failed reads).
        "**/v5-project-story.spec.ts",
        // The weekly update and the help it can ask for: post, see, offer, reply, Help found.
        "**/weekly-update-help.spec.ts",
        // The goal, the promises updates make and answer, the record, and starting a project alone.
        "**/project-goal-record.spec.ts",
        // Tasks with a finish line: made from an offer, handed in, sent back, confirmed by someone else; the profile.
        "**/project-tasks.spec.ts",
        // The moment between making a task and reading it back, on a server that is slow to answer.
        "**/project-tasks-slow-read.spec.ts",
        // Which projects are listed (one rule for every list), and a founder's "Not listed yet".
        "**/project-listing.spec.ts",
        // The list of every project is read a page at a time, apart from news; a failed page keeps what was read.
        "**/project-list-paging.spec.ts",
        // The Team section: add a person, their yes or no, a team member's update and check, and removal on the record.
        "**/project-team.spec.ts",
        // Home's Updates tab: a feed of project records, yours or everyone's, paged, from who may sign them.
        "**/home-record-feed.spec.ts",
        // "Your projects": what you started, help and follow, with the record and what needs you in each.
        "**/your-projects.spec.ts",
        // Home's next step: one line, one action, from facts read off signed records.
        "**/home-next-step.spec.ts",
        // Four places, one bell with one read state per server and account, and the older addresses.
        "**/app-nav.spec.ts",
        // Work: open requests across every listed project, and what waits on you.
        "**/work.spec.ts",
        // Agent accounts: labelled from their own profile, and not offered what the server refuses them.
        "**/agent-account.spec.ts",
        // Projects as a scoreboard: streaks, kept promises, open requests; nothing a founder can inflate by re-saving.
        "**/project-board.spec.ts",
        // The weekly rhythm: due and late words, the pre-filled update dialog, the note after posting, sharing.
        "**/weekly-rhythm.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
        // Escape hatch for machines whose Chromium is older than the build the
        // pinned Playwright wants (never `playwright install` for this), or
        // whose sandbox needs GPU-less headless (PW_CHROMIUM_EXTRA_ARGS, e.g.
        // `--disable-gpu`).
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
      // The pilot build (VITE_CONTRIBUTOR_ONLY=1) against a stubbed server, from a build folder and port of its own: run it
      // with scripts/web-pilot-e2e.sh. Anywhere else it skips itself, since the default build offers what it checks is gone.
      name: "pilot",
      // The listing spec holds in both builds, so it runs here too.
      testMatch: [
        "**/pilot-build.spec.ts",
        "**/project-listing.spec.ts",
        "**/app-nav.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
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
