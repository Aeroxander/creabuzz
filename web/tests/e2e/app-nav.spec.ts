import { expect, test, type Page } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import {
  DAY,
  event,
  install,
  now,
  openAs,
  projectRecord,
  pubkeyOf,
} from "./helpers/project-world";

/**
 * The app's four places (Home, Projects, Work, You), the one bell with one read state per server and account, and
 * the older addresses that must still open. Runs against both builds: the default one, and the contributor-only one
 * the pilot uses (where "You" shows only to someone with an account).
 */

const ME_KEY = "f1".repeat(32);
const OTHER_KEY = "f2".repeat(32);
const ME = pubkeyOf(ME_KEY);
const OTHER = pubkeyOf(OTHER_KEY);
const FOUNDER = pubkeyOf("f3".repeat(32));
const PILOT = process.env.E2E_PILOT_BUILD === "1";
const CHANNEL = "0f0f0f0f-1111-2222-3333-444444444444";

const places = (page: Page) =>
  page
    .getByTestId("app-nav")
    .locator('a[data-testid^="app-nav-"]:not([data-testid="app-nav-start"])')
    .evaluateAll((links) => links.map((a) => a.textContent?.trim()));

test("the navigation is four places, with no second way to the same thing", async ({
  page,
}) => {
  const relay = createMockRelay();
  await install(page, relay, ME_KEY);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("user-chip")).toBeVisible();
  expect(await places(page)).toEqual(["Home", "Projects", "Work", "You"]);
  const nav = page.getByTestId("app-nav");
  await expect(nav.getByText("Communities")).toHaveCount(0);
  await expect(nav.getByText("Discover")).toHaveCount(0);
  // Explore is no longer a place of its own beside Home.
  await expect(page.getByTestId("social-nav-explore")).toHaveCount(0);
  // One bell and one inbox.
  await expect(nav.getByTestId("social-nav-notifications")).toHaveCount(1);
  await expect(nav.getByTestId("social-nav-messages")).toHaveCount(1);

  await nav.getByTestId("app-nav-work").click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Work" }),
  ).toBeVisible();
  await expect(nav.getByTestId("app-nav-work")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await nav.getByTestId("app-nav-discover").click();
  await expect(page).toHaveURL(/\/discover$/);
  await nav.getByTestId("app-nav-portfolio").click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your projects" }),
  ).toBeVisible();

  // Rooms are reached from the account menu, and belong to You.
  await page.getByTestId("user-chip").click();
  await page.getByTestId("profile-menu-rooms").click();
  await expect(page).toHaveURL(/\/c(\/|$)/);
  await expect(nav.getByTestId("app-nav-portfolio")).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("signed out, the places are the same, except that the pilot build keeps You for people with an account", async ({
  page,
}) => {
  const relay = createMockRelay();
  await install(page, relay, null);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("app-nav-home")).toBeVisible();
  expect(await places(page)).toEqual(
    PILOT ? ["Home", "Projects", "Work"] : ["Home", "Projects", "Work", "You"],
  );
});

test("on a phone the four places and Start fit the bar", async ({ page }) => {
  const relay = createMockRelay();
  await install(page, relay, ME_KEY);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const nav = page.getByTestId("app-nav");
  await expect(nav).toHaveAttribute("data-layout", "phone");
  expect(await places(page)).toEqual(["Home", "Projects", "Work", "You"]);
  // Start sits in the middle of the four.
  await expect(nav.getByTestId("app-nav-start")).toBeVisible();
  expect(await nav.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  for (const id of ["home", "discover", "work", "portfolio"]) {
    const box = await nav.getByTestId(`app-nav-${id}`).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  }
});

test("older addresses still open", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - DAY));
  await install(page, relay, ME_KEY);
  await page.goto("/social/explore");
  await expect(
    page.getByRole("tab", { name: "Most discussed posts", exact: true }),
  ).toBeVisible();
  await page.goto("/c");
  await expect(page.getByTestId("app-nav")).toBeVisible();
  await expect(page).toHaveURL(/\/c/);
  await page.goto("/portfolio");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your projects" }),
  ).toBeVisible();
  await page.goto("/?tab=boards");
  await expect(page.getByRole("tab", { name: "Boards" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goto(`/launchpad/nebula?author=${FOUNDER}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nebula");
});

test("one bell counts what is new in rooms too, and reading it is remembered for this account only", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay();
  // A mention of me in a room, and one of someone else.
  const mention = (who: string, id: number) =>
    event(
      9,
      FOUNDER,
      "hello there",
      [
        ["h", CHANNEL],
        ["p", who],
      ],
      now() - 600 + id,
    );
  relay.seed(mention(ME, 1));
  relay.seed(mention(OTHER, 2));
  await install(page, relay, ME_KEY);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const bell = page
    .getByTestId("app-nav-inbox")
    .getByTestId("social-nav-notifications");
  await expect(bell.getByTestId("social-unread")).toHaveText("1", {
    timeout: 20_000,
  });
  // The Notifications page says where it is.
  await bell.click();
  await expect(page.getByTestId("social-rooms-notice")).toContainText(
    "1 new mention or notice in your rooms.",
  );
  // Looking at Notifications marks everything read, rooms included: one read state.
  await page.goto("/discover");
  await expect(bell).toBeVisible();
  await expect(bell.getByTestId("social-unread")).toHaveCount(0);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  // One note of it, naming the server and the account; none of the old unscoped ones.
  expect(keys.filter((k) => k.includes("notifications.seen"))).toEqual([
    expect.stringMatching(
      new RegExp(`^creaton\\.notifications\\.seen\\..+\\|${ME}$`),
    ),
  ]);

  // Someone else signing in on this browser has not read theirs.
  await openAs(page, OTHER_KEY, "/");
  await expect(bell.getByTestId("social-unread")).toHaveText("1", {
    timeout: 20_000,
  });
});
