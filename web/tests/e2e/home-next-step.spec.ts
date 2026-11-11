import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import { DAY, install, openAs } from "./helpers/project-world";
import {
  ME,
  ME_KEY,
  NEBULA,
  NEW_KEY,
  seeded,
  seedWorld,
} from "./helpers/your-projects-world";

/**
 * Home's next step, for someone signed in: the most pressing thing that needs them, as one line with one action,
 * from facts read off signed records. It can be put away for a day, never arrives under a reader who has scrolled
 * down, and says so when the facts cannot be read.
 */

test("Home shows the most pressing need as one line with one action, and it can be put away for a day", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, ME_KEY);
  await page.goto("/");
  const line = page.getByTestId("home-next-step");
  await expect(line).toHaveAttribute("data-kind", "check");
  await expect(line.getByTestId("home-next-step-text")).toHaveText(
    "Work is waiting for your check in Nebula: Record sign-up.",
  );
  // One line, one action; the rest is one tap away on the Work page.
  await expect(line.getByRole("link")).toHaveCount(2);
  await expect(line.getByTestId("home-next-step-more")).toHaveText(
    "5 more waiting",
  );
  await expect(line.getByTestId("home-next-step-more")).toHaveAttribute(
    "href",
    "/work",
  );
  await expect(line.getByTestId("home-next-step-action")).toHaveText(
    "Check the work",
  );
  await expectAccessible(page, "Home with a next step");

  await line.getByTestId("home-next-step-dismiss").click();
  await expect(line).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("home-top")).toBeVisible();
  await expect(page.getByTestId("user-chip")).toBeVisible();
  await expect(line).toHaveCount(0);

  // A day later it is back.
  await page.evaluate((day) => {
    const key = "creaton.next-step.dismissed";
    const note = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({ ...note, at: note.at - day - 5 }),
    );
  }, DAY);
  await page.reload();
  await expect(line.getByTestId("home-next-step-text")).toContainText(
    "Work is waiting for your check in Nebula",
  );
  await line.getByTestId("home-next-step-action").click();
  await expect(page).toHaveURL(new RegExp(`#task-${seeded.checkTaskId}$`));
});

test("the next step never arrives under a reader who has already scrolled down the page", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // A short window, so Home scrolls.
  await page.setViewportSize({ width: 1280, height: 420 });
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // The server is slow to say which projects are this person's.
  const ownRecords = (filter: { [key: string]: unknown }) =>
    Array.isArray(filter.kinds) &&
    (filter.kinds as number[]).includes(37001) &&
    Array.isArray(filter.authors) &&
    (filter.authors as string[]).includes(ME) &&
    !filter["#d"];
  relay.holdReads(ownRecords);
  await install(page, relay, ME_KEY);
  await page.goto("/");
  await expect(page.getByTestId("user-chip")).toBeVisible();
  await expect(page.getByTestId("social-rail-projects")).toBeVisible();
  // Home's timeline scrolls inside its shell.
  const shell = page.getByTestId("social-shell");
  const scrolled = () => shell.evaluate((el) => el.scrollTop);
  await shell.evaluate((el) => {
    el.scrollTop = 300;
  });
  expect(await scrolled()).toBeGreaterThan(100);
  const before = await scrolled();

  relay.releaseReads();
  // The facts are read now (the read of what Nebula's team signed about it was answered)…
  await expect
    .poll(() =>
      relay
        .reqsReceived()
        .flat()
        .some(
          (f) =>
            f.kinds?.includes(47003) &&
            Array.isArray(f["#a"]) &&
            (f["#a"] as string[]).includes(NEBULA) &&
            Array.isArray(f.authors) &&
            !f["#l"] &&
            !f["#e"],
        ),
    )
    .toBe(true);
  await page.waitForTimeout(1500);
  // …and nothing was put above what the reader was reading.
  await expect(page.getByTestId("home-next-step")).toHaveCount(0);
  expect(await scrolled()).toBe(before);

  // On the next visit, at the top of the page, it is there. (A reload keeps where the reader had scrolled to.)
  await shell.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.reload();
  await expect(page.getByTestId("home-next-step")).toHaveAttribute(
    "data-kind",
    "check",
  );
});

test("someone with no project yet is offered to start one or help one; a visitor sees no line", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, NEW_KEY);
  await page.goto("/");
  const line = page.getByTestId("home-next-step");
  await expect(line).toHaveAttribute("data-kind", "start");
  await expect(line.getByTestId("home-next-step-text")).toContainText(
    "You have no project yet.",
  );
  await expect(line.getByTestId("home-next-step-action")).toHaveText(
    "Start a project",
  );
  await expect(
    line.getByRole("link", { name: "find work on one" }),
  ).toHaveAttribute("href", "/work");

  await openAs(page, null, "/");
  await expect(page.getByTestId("home-top")).toBeVisible();
  await expect(line).toHaveCount(0);
});

test("when the facts cannot be read, Home says so instead of saying nothing needs you", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  relay.setClosingSockets(
    (filter) =>
      Boolean(filter?.kinds?.includes(37001)) &&
      Array.isArray(filter?.authors) &&
      (filter.authors as string[]).includes(ME) &&
      !filter?.["#d"],
  );
  await install(page, relay, ME_KEY);
  await page.goto("/");
  await expect(page.getByTestId("home-next-step-failed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("home-next-step")).toHaveCount(0);
  relay.setClosingSockets(false);
  await page
    .getByTestId("home-next-step-failed")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(page.getByTestId("home-next-step")).toHaveAttribute(
    "data-kind",
    "check",
    { timeout: 30_000 },
  );
});

test("at 390px Home's next step fits with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, ME_KEY);
  await page.goto("/");
  await expect(page.getByTestId("home-next-step")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
