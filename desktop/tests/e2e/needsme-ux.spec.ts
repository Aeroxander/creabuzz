/**
 * Needs-me approval queue screenshots (P0 operator loop, part 1).
 *
 * Documents the rebuilt "Needs action" surface: inline NeedsMeApprovalCards in
 * the inbox list (fresh vs. amber aging treatment) and the detail-pane card.
 * Run: pnpm build:e2e && pnpm exec playwright test --project=smoke \
 *        tests/e2e/needsme-ux.spec.ts
 * Output: test-results/needsme-ux/
 */
import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/needsme-ux";

// Mock bridge default pubkey — must match DEFAULT_MOCK_PUBKEY in bridge.ts.
const MOCK_PUBKEY = "deadbeef".repeat(8);
// A managed-agent-style subject the profile hooks will not resolve → PubKey
// chip fallback, exactly what an unprofiled agent key looks like.
const SUBJECT_PUBKEY = "b".repeat(64);
const TOKEN_FRESH = "c".repeat(64);
const TOKEN_AGING = "d".repeat(64);
const NOW = Math.floor(Date.now() / 1000);

type MockFeedWindow = Window & {
  __BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?: (item: {
    category: "mention" | "needs_action" | "activity" | "agent_activity";
    channel_id: string | null;
    channel_name: string;
    content: string;
    created_at: number;
    id: string;
    kind: number;
    pubkey: string;
    tags: string[][];
  }) => unknown;
};

async function patchCommunityPubkey(page: Page) {
  await page.addInitScript(
    ({ pubkey }) => {
      const raw = window.localStorage.getItem("buzz-communities");
      const communities = raw
        ? (JSON.parse(raw) as Array<Record<string, unknown>>)
        : [];
      if (communities[0]) {
        communities[0].pubkey = pubkey;
        window.localStorage.setItem(
          "buzz-communities",
          JSON.stringify(communities),
        );
      }
    },
    { pubkey: MOCK_PUBKEY },
  );
}

async function pushNeedsMeApprovals(page: Page) {
  await page.evaluate(
    ({ now, subject, tokenFresh, tokenAging }) => {
      const win = window as MockFeedWindow;
      const push = win.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__;
      if (!push) throw new Error("mock feed helper missing");
      push({
        id: "needsme-fresh",
        kind: 46010,
        pubkey: subject,
        content: JSON.stringify({
          type: "budget-exceeded",
          subject,
          counterType: "spend",
          window: "day",
          limit: 500,
        }),
        created_at: now - 3600,
        channel_id: null,
        channel_name: "",
        tags: [
          ["d", tokenFresh],
          ["p", subject],
        ],
        category: "needs_action",
      });
      push({
        id: "needsme-aging",
        kind: 46010,
        pubkey: subject,
        content: JSON.stringify({
          type: "budget-exceeded",
          subject,
          counterType: "runs",
          window: "week",
          limit: 25,
        }),
        created_at: now - 2 * 24 * 60 * 60,
        channel_id: null,
        channel_name: "",
        tags: [
          ["d", tokenAging],
          ["p", subject],
        ],
        category: "needs_action",
      });
    },
    {
      now: NOW,
      subject: SUBJECT_PUBKEY,
      tokenFresh: TOKEN_FRESH,
      tokenAging: TOKEN_AGING,
    },
  );
}

async function openNeedsActionFilter(page: Page) {
  await page.getByTestId("inbox-filter-trigger").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Needs action" }).click();
  await expect(page.getByTestId("home-inbox-list")).toBeVisible();
}

test.describe("needs-me UX screenshots", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  });

  test("01 — approval queue with fresh and aging cards", async ({ page }) => {
    await patchCommunityPubkey(page);
    await installMockBridge(page, { mode: "mock" });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-inbox-list")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForFunction(
      () =>
        typeof (window as MockFeedWindow).__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ ===
        "function",
    );

    await pushNeedsMeApprovals(page);
    await expect(
      page.getByTestId("home-inbox-needs-me-needsme-fresh"),
    ).toBeVisible();
    await expect(
      page.getByTestId("home-inbox-needs-me-needsme-aging"),
    ).toBeVisible();

    await openNeedsActionFilter(page);
    await expect(
      page.getByTestId("home-inbox-needs-me-needsme-aging"),
    ).toBeVisible();

    // Aging card carries the amber token treatment; fresh one does not.
    await expect(
      page.locator('[data-testid="home-inbox-needs-me-needsme-aging"]'),
    ).toHaveAttribute("data-aging", "true");
    await expect(
      page.locator('[data-testid="home-inbox-needs-me-needsme-fresh"]'),
    ).not.toHaveAttribute("data-aging", "true");

    await waitForAnimations(page);
    await page
      .getByTestId("home-inbox-list")
      .screenshot({ path: `${SHOTS}/01-needsme-queue.png` });
  });

  test("02 — selected approval shows the inline card in the detail pane", async ({
    page,
  }) => {
    await patchCommunityPubkey(page);
    await installMockBridge(page, { mode: "mock" });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-inbox-list")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForFunction(
      () =>
        typeof (window as MockFeedWindow).__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ ===
        "function",
    );

    await pushNeedsMeApprovals(page);
    const freshRow = page.locator(
      '[data-testid="home-inbox-item-needsme-fresh"]',
    );
    await expect(freshRow).toBeVisible();
    await freshRow.click();
    await expect(
      page.getByTestId("home-inbox-needs-me-detail-needsme-fresh"),
    ).toBeVisible({ timeout: 10_000 });

    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/02-needsme-detail.png` });
  });
});
