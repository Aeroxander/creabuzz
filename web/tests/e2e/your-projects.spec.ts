import { expect, test, type Page } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import { install } from "./helpers/project-world";
import {
  COMET,
  ME_KEY,
  seeded,
  seedWorld,
} from "./helpers/your-projects-world";

/**
 * "Your projects" (the page that was Portfolio): the projects a person started, helps and follows, each with its last
 * update, how its promises stand, its open requests for help and what needs the person now, with no price, amount or
 * return anywhere on it. Everything is read from signed records, by who signed them; a read that fails is said.
 */

const card = (page: Page, group: string, name: string) =>
  page
    .getByTestId(group)
    .locator('[data-testid="your-project"], [data-testid="portfolio-followed"]')
    .filter({ hasText: name });
const needKinds = (scope: ReturnType<typeof card>) =>
  scope
    .getByTestId("your-project-need")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")));

test("Your projects lists what you started, help and follow, with the record and what needs you; no prices", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, ME_KEY);
  await page.goto("/portfolio");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your projects" }),
  ).toBeVisible();

  const nebula = card(page, "your-projects-started", "Nebula");
  await expect(nebula.getByTestId("your-project-update")).toHaveText(
    "No update in 10 days",
  );
  await expect(nebula.getByTestId("your-project-promises")).toHaveText(
    "1 kept, 1 missed, 0 changed",
  );
  await expect(nebula.getByTestId("your-project-help")).toHaveText(
    "1 open request",
  );
  // What others wait on comes first: the work to check, the offer to answer, then the update that is due.
  await expect
    .poll(() => needKinds(nebula))
    .toEqual(["check", "offers", "update-due"]);
  await expect(nebula).toContainText(
    "Work is waiting for your check in Nebula: Record sign-up.",
  );
  await expect(nebula).toContainText(
    "An offer to help with Nebula is waiting for your reply.",
  );
  await expect(nebula).toContainText("Nebula's last update was 10 days ago.");

  const orbit = card(page, "your-projects-helping", "Orbit");
  // Their own tasks, the one waiting on them first.
  const tasks = orbit.getByTestId("your-project-task");
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toContainText("Draw the logo.");
  await expect(tasks.nth(0)).toContainText("Waiting for a yes");
  await expect(tasks.nth(1)).toContainText("Write the readme.");
  await expect(tasks.nth(1)).toContainText("In progress");
  await expect(tasks.nth(1)).toContainText("Due ");
  await expect.poll(() => needKinds(orbit)).toEqual(["task-yes", "task-due"]);
  // Not on Orbit's team: nothing about checking its work or answering its offers.
  await expect(orbit).not.toContainText("waiting for your check");

  const comet = card(page, "your-projects-following", "Comet");
  await expect(comet.getByTestId("your-project-update")).toHaveText(
    "Updated today",
  );
  await expect(comet.getByTestId("your-project-no-needs")).toHaveText(
    "Nothing right now.",
  );

  const dune = card(page, "your-projects-invited", "Dune");
  await expect.poll(() => needKinds(dune)).toEqual(["invitation"]);
  await expect(dune).toContainText(
    "Dune added you to its team. Say yes or no.",
  );

  // The record part of the page names no price, amount or return.
  await expect(page.getByTestId("your-projects")).not.toContainText(
    /\$|Shares|earn|price|return/i,
  );
  await expectAccessible(page, "Your projects");

  // A need leads to where it is acted on.
  await nebula.getByRole("link", { name: "Check the work" }).click();
  await expect(page).toHaveURL(new RegExp(`#task-${seeded.checkTaskId}$`));
  await expect(
    page.getByTestId("project-tasks").getByTestId("task"),
  ).toContainText("Record sign-up.");
});

test("a project whose record cannot be read says so on its card, with a retry; the others still show", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // The read of what Comet's team signed about it never answers.
  relay.setClosingSockets(
    (filter) =>
      Boolean(filter?.kinds?.includes(47003)) &&
      Array.isArray(filter?.["#a"]) &&
      (filter["#a"] as string[]).includes(COMET) &&
      Array.isArray(filter?.authors),
  );
  await install(page, relay, ME_KEY);
  await page.goto("/portfolio");
  const comet = card(page, "your-projects-following", "Comet");
  await expect(comet.getByTestId("your-project-failed")).toBeVisible({
    timeout: 60_000,
  });
  // Nothing is claimed about it: no "Updated…" line, no "Nothing right now."
  await expect(comet.getByTestId("your-project-update")).toHaveCount(0);
  await expect(comet.getByTestId("your-project-no-needs")).toHaveText(
    "Not known yet.",
  );
  await expect(
    card(page, "your-projects-started", "Nebula").getByTestId(
      "your-project-update",
    ),
  ).toHaveText("No update in 10 days");
  relay.setClosingSockets(false);
  await comet.getByRole("button", { name: "Try again" }).click();
  await expect(comet.getByTestId("your-project-update")).toHaveText(
    "Updated today",
    { timeout: 30_000 },
  );
});

test("signed out, the page says what an account is for and lists nothing as yours", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, null);
  await page.goto("/portfolio");
  await expect(page.getByTestId("your-projects-signed-out")).toBeVisible();
  await expect(page.getByTestId("your-project")).toHaveCount(0);
});

test("at 390px Your projects fits with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, ME_KEY);
  await page.goto("/portfolio");
  await expect(
    card(page, "your-projects-started", "Nebula").getByTestId(
      "your-project-update",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
