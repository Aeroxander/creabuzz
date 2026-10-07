import { expect, test, type Page } from "@playwright/test";

import { FOUNDER_NSEC, mockLaunchRelay } from "../helpers/funding-fixture";

/**
 * The funding status in the app: what a project says about raising, and what
 * its records prove, cannot contradict each other on a card (plan §2,
 * docs/funding-and-governance-plan.md).
 *
 * Runs against the mocked relay, so the derivation rules are exercised the
 * way a person meets them — on cards, in the chip counts, and in the
 * founder's workspace — not only through `lib/funding.test.mjs`. The world
 * itself is `tests/helpers/funding-fixture.ts`, shared with the simulation.
 */

test.beforeEach(async ({ page }) => {
  await mockLaunchRelay(page);
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await page.goto("/launchpad");
});

/** The card for one project, by its title. */
function card(page: Page, name: string) {
  return page.locator('[data-testid="launch-card"]').filter({ hasText: name });
}

test("every card states the project's funding status", async ({ page }) => {
  await expect(
    card(page, "Aurora").getByTestId("launch-funding-badge"),
  ).toHaveText("Planning a raise · looking for backers");
  await expect(
    card(page, "Beacon").getByTestId("launch-funding-badge"),
  ).toHaveText("Not raising · looking for contributors");
});

test("a live sale overrides a claim that cannot hold", async ({ page }) => {
  // Cygnus still declares "Not raising", but a sale is on file: the card says
  // what the money is doing, not what the record claims.
  await expect(
    card(page, "Cygnus").getByTestId("launch-funding-badge"),
  ).toHaveText("Raising now");
});

test("a finished raise does not close a rolling round", async ({ page }) => {
  await expect(
    card(page, "Draco").getByTestId("launch-funding-badge"),
  ).toHaveText("Rolling round");
});

test("the chips count each stance and each wanted role", async ({ page }) => {
  await expect(page.getByTestId("funding-chip-any-count")).toHaveText("4");
  await expect(page.getByTestId("funding-chip-planning-count")).toHaveText("1");
  await expect(page.getByTestId("funding-chip-not-raising-count")).toHaveText(
    "1",
  );
  await expect(page.getByTestId("funding-chip-raising-count")).toHaveText("1");
  await expect(page.getByTestId("funding-chip-rolling-count")).toHaveText("1");
  await expect(page.getByTestId("funding-chip-closing-count")).toHaveText("0");
  await expect(page.getByTestId("seeking-chip-backers-count")).toHaveText("1");
  await expect(page.getByTestId("seeking-chip-contributors-count")).toHaveText(
    "1",
  );
  await expect(page.getByTestId("seeking-chip-advisors-count")).toHaveText("0");
});

test("a chip filters the list to that stance", async ({ page }) => {
  await page.getByTestId("funding-chip-planning").click();
  await expect(card(page, "Aurora")).toBeVisible();
  await expect(card(page, "Beacon")).toHaveCount(0);
  await expect(card(page, "Cygnus")).toHaveCount(0);
  // Turning the chip off brings everything back.
  await page.getByTestId("funding-chip-planning").click();
  await expect(card(page, "Cygnus")).toBeVisible();
});

test("the directory leads with what is raising now", async ({ page }) => {
  const titles = page.getByTestId("launch-card-title");
  await expect(titles.first()).toHaveText("Cygnus");
  // The rest keep the usual newest-first order.
  await expect(titles.nth(1)).toHaveText("Aurora");
  await expect(titles.nth(2)).toHaveText("Beacon");
  await expect(titles.nth(3)).toHaveText("Draco");
});

test("a plan left standing is nudged on the founder's own page", async ({
  page,
}) => {
  // Aurora declared a plan and its record is from long ago.
  await card(page, "Aurora").getByTestId("launch-card-title").click();
  await page.getByRole("tab", { name: "Manage" }).click();
  await expect(page.getByTestId("funding-nudge")).toBeVisible();
  await expect(
    page.getByTestId("funding-nudge").getByRole("button"),
  ).toHaveText("Update funding status");
});
