import { expect, test } from "@playwright/test";

/**
 * Narrow-viewport layout (roadmap item A).
 *
 * The shell used to be a fixed 240px column plus a content pane, which left the
 * timeline an unreadable sliver on a phone. These tests bind the production
 * layout: the channel list must be off-canvas below `lg`, reachable from the
 * header button, and dismissed when a channel is picked. The desktop assertions
 * guard the other direction — the breakpoint must not change >=1024px.
 */

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

const directory = {
  communities: [
    {
      host: "alpha.example.com",
      name: "Alpha",
      description: "A test community.",
      icon: null,
      member_count: 3,
      archived: false,
    },
  ],
};

function channelEvent() {
  return {
    id: "chan-event-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
      ["about", "General chatter"],
    ],
    content: "",
    sig: "sig",
  };
}

async function boot(page: import("@playwright/test").Page) {
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(directory),
    });
  });
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if ((filter.kinds ?? []).includes(39000)) {
        ws.send(JSON.stringify(["EVENT", subId, channelEvent()]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await page.goto("/c/alpha.example.com");
  await expect(page.getByTestId("content-pane")).toBeVisible();
}

async function box(page: import("@playwright/test").Page, selector: string) {
  const bounding = await page.locator(selector).boundingBox();
  expect(bounding, `${selector} has no layout box`).not.toBeNull();
  return bounding as { x: number; y: number; width: number; height: number };
}

test.describe("narrow viewport", () => {
  test.use({ viewport: MOBILE });

  test("the channel list is off-canvas and the content fills the width", async ({
    page,
  }) => {
    await boot(page);

    const sidebar = await box(page, "#channel-sidebar");
    expect(
      sidebar.x + sidebar.width,
      "sidebar should start off-screen at 390px",
    ).toBeLessThanOrEqual(0);

    const pane = await box(page, "[data-testid='content-pane']");
    expect(
      pane.width,
      "content pane should use nearly the whole viewport",
    ).toBeGreaterThan(MOBILE.width * 0.9);

    await page.screenshot({
      path: "test-results/responsive/01-mobile-channel-closed.png",
    });
  });

  test("the header button opens the channel list and selecting one closes it", async ({
    page,
  }) => {
    await boot(page);

    const toggle = page.getByTestId("open-channel-list");
    await expect(toggle).toBeVisible();
    await toggle.click();

    // The panel slides in over 200ms; poll instead of sampling mid-transition.
    await expect
      .poll(async () => (await box(page, "#channel-sidebar")).x)
      .toBeGreaterThanOrEqual(0);
    expect((await box(page, "#channel-sidebar")).width).toBeGreaterThan(200);

    await page.screenshot({
      path: "test-results/responsive/02-mobile-channel-list-open.png",
    });

    await page
      .getByRole("button", { name: /general/ })
      .first()
      .click();
    await expect
      .poll(async () => (await box(page, "#channel-sidebar")).x)
      .toBeLessThanOrEqual(0);
  });

  test("the wiki page list stacks above the editor", async ({ page }) => {
    await boot(page);
    await page.getByTestId("open-channel-list").click();
    await page.getByTestId("wiki-toggle").click();

    const list = await box(page, "[data-testid='wiki-page-list']");
    expect(
      list.width,
      "page list should span the viewport on a phone",
    ).toBeGreaterThan(MOBILE.width * 0.9);
    expect(list.height, "page list should be a capped strip").toBeLessThan(200);

    await page.screenshot({
      path: "test-results/responsive/03-mobile-wiki.png",
    });
  });
});

test.describe("desktop viewport", () => {
  test.use({ viewport: DESKTOP });

  test("the channel list stays a static column and no header button appears", async ({
    page,
  }) => {
    await boot(page);

    // The channel list sits directly under the app's top bar, at the left edge.
    const nav = await box(page, "[data-testid='app-nav']");
    const sidebar = await box(page, "#channel-sidebar");
    expect(sidebar.x).toBe(0);
    expect(sidebar.y).toBe(nav.y + nav.height);
    expect(sidebar.width).toBeGreaterThan(200);

    const pane = await box(page, "[data-testid='content-pane']");
    expect(pane.x).toBeGreaterThan(sidebar.width - 1);

    await expect(page.getByTestId("open-channel-list")).toBeHidden();

    await page.screenshot({
      path: "test-results/responsive/04-desktop-channel.png",
    });
  });
});
