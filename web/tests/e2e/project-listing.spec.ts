import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import {
  DAY,
  install,
  newest,
  now,
  openAs,
  projectPath,
  projectRecord,
  pubkeyOf,
} from "./helpers/project-world";

/**
 * Which projects are listed, in the browser. A project started with the short form is public and listed (Discover,
 * Home's side panel); one whose founder chose "Not listed yet" is in no list and says so on its page; a sale still
 * being set up is not listed. The same rule holds in both builds: this spec runs against the default build (the
 * smoke project) and against the contributor-only build the pilot uses (the pilot project, scripts/web-pilot-e2e.sh).
 */

const FOUNDER_KEY = "a1".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const OTHER = pubkeyOf("a2".repeat(32));

test("a project started with the short form is listed in Discover and on Home, signed out", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - DAY));
  // A sale still being set up: a draft that already names sale terms.
  relay.seed(
    projectRecord(OTHER, "half-sale", "Half Sale", now() - 2 * DAY, {
      content: { requiredRaised: "1000", floorPrice: "1" },
    }),
  );
  await install(page, relay, null);
  await page.goto("/discover");
  const list = page.getByTestId("discover-launch-list");
  await expect(list.getByText("Nebula", { exact: true })).toBeVisible();
  await expect(list.getByText("Half Sale")).toHaveCount(0);
  await expect(page.getByTestId("discover-empty")).toHaveCount(0);

  await page.goto("/");
  const rail = page.getByTestId("social-rail-projects");
  await expect(rail.getByText("Nebula", { exact: true })).toBeVisible();
  await expect(rail.getByText("Half Sale")).toHaveCount(0);
});

test("a project marked not listed yet is in no list, and its page says so to a visitor", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - DAY));
  relay.seed(
    projectRecord(FOUNDER, "quiet", "Quiet Work", now() - DAY, {
      content: { listing: "unlisted" },
    }),
  );
  await install(page, relay, null);
  await page.goto("/discover");
  const list = page.getByTestId("discover-launch-list");
  await expect(list.getByText("Nebula", { exact: true })).toBeVisible();
  await expect(list.getByText("Quiet Work")).toHaveCount(0);
  await page.goto("/");
  await expect(
    page
      .getByTestId("social-rail-projects")
      .getByText("Nebula", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("social-rail-projects").getByText("Quiet Work"),
  ).toHaveCount(0);

  // The page still opens from its link, and says it is not listed. A visitor gets no button.
  await page.goto(projectPath(FOUNDER, "quiet"));
  await expect(page.getByTestId("project-listing-state")).toHaveText(
    "Not listed yet. Only people with the link can find this project.",
  );
  await expect(page.getByTestId("project-listing-toggle")).toHaveCount(0);
  // A listed project says nothing about listing to a visitor.
  await page.goto(projectPath(FOUNDER, "nebula"));
  await expect(page.getByRole("heading", { name: "Nebula" })).toBeVisible();
  await expect(page.getByTestId("project-listing")).toHaveCount(0);
});

test("a founder takes their project off the lists and puts it back, keeping the rest of the record", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - DAY, {
      tags: [["team", OTHER, "member"]],
    }),
  );
  await install(page, relay, FOUNDER_KEY);
  await page.goto(projectPath(FOUNDER, "nebula"));
  await expect(page.getByTestId("project-listing-state")).toContainText(
    "Listed.",
  );
  await page.getByTestId("project-listing-toggle").click();
  await expect(page.getByTestId("project-listing-state")).toHaveText(
    "Not listed yet. Only people with the link can find this project.",
  );
  await expect
    .poll(() => newest(relay, 37001, FOUNDER)?.body.listing)
    .toBe("unlisted");
  // One record, published over the old one: the name and the pitch are still there.
  const saved = newest(relay, 37001, FOUNDER);
  expect(saved?.body.pitch).toBe("Nebula, in one sentence.");
  expect(saved?.tags).toContainEqual(["name", "Nebula"]);

  // Nobody finds it in a list now.
  await openAs(page, null, "/discover");
  await expect(page.getByTestId("discover-empty")).toBeVisible();
  await expect(page.getByText("Nebula", { exact: true })).toHaveCount(0);

  // The founder lists it again.
  await openAs(page, FOUNDER_KEY, projectPath(FOUNDER, "nebula"));
  await expect(page.getByTestId("project-listing-toggle")).toHaveText(
    "List this project",
  );
  await page.getByTestId("project-listing-toggle").click();
  await expect(page.getByTestId("project-listing-state")).toContainText(
    "Listed.",
  );
  await expect
    .poll(() => newest(relay, 37001, FOUNDER)?.body.listing)
    .toBeUndefined();
  await openAs(page, null, "/discover");
  await expect(
    page.getByTestId("discover-launch-list").getByText("Nebula", {
      exact: true,
    }),
  ).toBeVisible();
});

test("a listing change the server refuses is said, and the page goes back to what is true", async ({
  page,
}) => {
  let refusing = true;
  const relay = createMockRelay({
    applyDeletions: true,
    refuse: (e) =>
      refusing && e.kind === 37001 ? "error: database error: down" : null,
  });
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - DAY));
  await install(page, relay, FOUNDER_KEY);
  await page.goto(projectPath(FOUNDER, "nebula"));
  await page.getByTestId("project-listing-toggle").click();
  await expect(page.getByTestId("project-listing-failed")).toContainText(
    "The project is still listed",
  );
  await expect(page.getByTestId("project-listing-state")).toContainText(
    "Listed.",
  );
  // The same button is the retry.
  refusing = false;
  await page.getByTestId("project-listing-toggle").click();
  await expect(page.getByTestId("project-listing-state")).toContainText(
    "Not listed yet.",
  );
  await expect(page.getByTestId("project-listing-failed")).toHaveCount(0);
});
