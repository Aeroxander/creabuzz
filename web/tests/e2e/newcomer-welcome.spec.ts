import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  openAs,
  projectRecord,
  pubkeyOf,
} from "./helpers/project-world";
import {
  COMET,
  ME_KEY,
  NEW_KEY,
  seedWorld,
} from "./helpers/your-projects-world";

/**
 * The newcomer's welcome on Home: three ways in, shown once to an account tied to no project. "Just follow some
 * projects" offers up to five, the active ones first, each with Follow. Choosing a way in or "Not now" puts it away
 * for that account for good; someone with a project, and a visitor, never see it.
 */

const NEW = pubkeyOf(NEW_KEY);
const SECOND_KEY = "e8".repeat(32);
const F1 = pubkeyOf("f1".repeat(32));
const F2 = pubkeyOf("f2".repeat(32));

function seed() {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // Two more listed projects, so there are more than five to choose from; Fern posted on three days this week.
  relay.seed(projectRecord(F1, "fern", "Fern", now() - 20 * DAY));
  relay.seed(projectRecord(F2, "gale", "Gale", now() - 3600));
  for (const ago of [0, 1, 2])
    relay.seed(
      event(
        47003,
        F1,
        { title: "Day", body: "" },
        [
          ["a", coordOf(F1, "fern")],
          ["update-kind", "weekly"],
        ],
        now() - ago * DAY - 120,
      ),
    );
  return relay;
}

test("a newcomer picks a way in; following from the welcome is one tap each, and it never comes back", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = seed();
  await install(page, relay, NEW_KEY);
  await page.goto("/");
  const welcome = page.getByTestId("newcomer-welcome");
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await expect(welcome.getByTestId("welcome-start")).toHaveAttribute(
    "href",
    "/start",
  );
  await expect(welcome.getByTestId("welcome-work")).toHaveAttribute(
    "href",
    "/work",
  );
  // The usual next step waits behind the welcome: one thing at a time.
  await expect(page.getByTestId("home-next-step")).toHaveCount(0);
  await expectAccessible(page, "Home with the newcomer's welcome");

  await welcome.getByTestId("welcome-follow-some").click();
  const items = welcome.getByTestId("welcome-follow-item");
  await expect(items).toHaveCount(5);
  // The active ones first: Fern posted on three days, Comet today; then the newest.
  await expect(items.nth(0)).toContainText("Fern");
  await expect(items.nth(1)).toContainText("Comet");
  await expect(items.nth(2)).toContainText("Gale");
  await expect(welcome).not.toContainText(/\$|price|earn|trending|hot/i);
  await items.nth(1).getByTestId("welcome-follow").click();
  await expect
    .poll(() =>
      relay.events.some(
        (e) =>
          e.kind === 10003 &&
          e.pubkey === NEW &&
          e.tags.some((t) => t[0] === "a" && t[1] === COMET),
      ),
    )
    .toBe(true);
  await welcome.getByTestId("welcome-done").click();
  await expect(welcome).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("home-top")).toBeVisible();
  await expect(page.getByTestId("home-next-step")).toBeVisible({
    timeout: 30_000,
  });
  await expect(welcome).toHaveCount(0);
});

test("Not now puts it away for that account only; a way in counts as seen too", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = seed();
  await install(page, relay, NEW_KEY);
  await page.goto("/");
  const welcome = page.getByTestId("newcomer-welcome");
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByTestId("welcome-dismiss").click();
  await expect(welcome).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("home-next-step")).toBeVisible({
    timeout: 30_000,
  });
  await expect(welcome).toHaveCount(0);

  // Another new account in the same browser has not seen it. Taking "Find work" is a choice: it does not return.
  await openAs(page, SECOND_KEY, "/");
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByTestId("welcome-work").click();
  await expect(page.getByTestId("work-page")).toBeVisible();
  await page.goto("/");
  await expect(page.getByTestId("home-next-step")).toBeVisible({
    timeout: 30_000,
  });
  await expect(welcome).toHaveCount(0);
});

test("someone with a project, and a visitor, never see the welcome", async ({
  page,
}) => {
  const relay = seed();
  await install(page, relay, ME_KEY);
  await page.goto("/");
  await expect(page.getByTestId("home-next-step")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("newcomer-welcome")).toHaveCount(0);
  await openAs(page, null, "/");
  await expect(page.getByTestId("home-welcome-start")).toBeVisible();
  await expect(page.getByTestId("newcomer-welcome")).toHaveCount(0);
});

test("at 390px the welcome fits with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = seed();
  await install(page, relay, NEW_KEY);
  await page.goto("/");
  const welcome = page.getByTestId("newcomer-welcome");
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByTestId("welcome-follow-some").click();
  await expect(welcome.getByTestId("welcome-follow-item")).toHaveCount(5);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
