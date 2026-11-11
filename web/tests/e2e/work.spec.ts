import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";
import { ME_KEY, seedWorld } from "./helpers/your-projects-world";

/**
 * The Work page: every open request for help across the listed projects in one list, filtered by size, with "I can
 * do this" as the one tap; and, signed in, everything that is waiting on you first. Requests a team marked as found,
 * and projects that are not listed, are not on it. A failed read is said, never shown as "no work".
 */

const A = pubkeyOf("91".repeat(32));
const B = pubkeyOf("92".repeat(32));
const C = pubkeyOf("93".repeat(32));

function ask(
  relay: Relay,
  founder: string,
  id: string,
  text: string,
  size: string,
  at: number,
) {
  const update = event(
    47003,
    founder,
    { title: "This week", body: "" },
    [
      ["a", coordOf(founder, id)],
      ["help-needed", text],
      ["help-size", size],
    ],
    at,
  );
  relay.seed(update);
  return update;
}

function seedRequests(relay: Relay) {
  relay.seed(projectRecord(A, "atlas", "Atlas", now() - 30 * DAY));
  relay.seed(projectRecord(B, "birch", "Birch", now() - 20 * DAY));
  relay.seed(projectRecord(C, "cedar", "Cedar", now() - 10 * DAY));
  relay.seed(
    projectRecord(C, "quiet", "Quiet Work", now() - 5 * DAY, {
      content: { listing: "unlisted" },
    }),
  );
  const atlas = ask(
    relay,
    A,
    "atlas",
    "Test sign-up on an old phone.",
    "small",
    now() - 3 * DAY,
  );
  ask(relay, B, "birch", "Design the landing page.", "large", now() - 2 * DAY);
  // Cedar asked, and its founder has since marked the help as found.
  const cedar = ask(relay, C, "cedar", "Write the docs.", "small", now() - DAY);
  relay.seed(
    event(
      47003,
      C,
      { title: "Help found", body: "" },
      [
        ["a", coordOf(C, "cedar")],
        ["e", cedar.id],
        ["help-found", cedar.id],
      ],
      now() - 3600,
    ),
  );
  ask(relay, C, "quiet", "A secret task.", "small", now() - 60);
  return { atlas };
}

test("open work across every listed project is one list, by size, with one tap to offer", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const { atlas } = seedRequests(relay);
  await install(page, relay, null);
  await page.goto("/work");
  const open = page.getByTestId("work-open");
  const items = open.getByTestId("work-open-item");
  // Newest first; the request marked found and the project that is not listed are not here.
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Birch");
  await expect(items.nth(0)).toContainText("Design the landing page.");
  await expect(items.nth(0)).toContainText("Large");
  await expect(items.nth(1)).toContainText("Atlas");
  await expect(open).not.toContainText("Write the docs.");
  await expect(open).not.toContainText("A secret task.");
  await expect(open.getByTestId("work-open-count")).toHaveText(
    "2 open requests",
  );
  // Signed out there is nothing "waiting on you".
  await expect(page.getByTestId("work-waiting")).toHaveCount(0);
  await expectAccessible(page, "Work");

  await open.getByTestId("work-size-small").click();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("Atlas");
  await open.getByTestId("work-size-medium").click();
  await expect(open.getByTestId("work-open-empty")).toContainText(
    "Nothing of that size right now.",
  );
  await open.getByTestId("work-size-all").click();
  await expect(items).toHaveCount(2);

  // The one tap leads to the request on its project's page, where the offer is made.
  await items.nth(1).getByTestId("work-open-do").click();
  await expect(page).toHaveURL(new RegExp(`#update-${atlas.id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Atlas");
});

test("signed in, everything waiting on you comes first, each with its one action", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, ME_KEY);
  await page.goto("/work");
  const waiting = page.getByTestId("work-waiting");
  await expect
    .poll(
      () =>
        waiting
          .getByTestId("work-waiting-item")
          .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-kind"))),
      { timeout: 30_000 },
    )
    .toEqual([
      "check",
      "offers",
      "task-yes",
      "invitation",
      "task-due",
      "update-due",
    ]);
  const first = waiting.getByTestId("work-waiting-item").first();
  await expect(first).toContainText("Work is waiting for your check in Nebula");
  await expect(first.getByRole("link")).toHaveText("Check the work");
  // Their own project's request is in the open list too.
  await expect(page.getByTestId("work-open")).toContainText(
    "Someone to test on an older phone.",
  );
});

test("when the open requests cannot be checked the page says so, with a retry", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedRequests(relay);
  // The read of what answers the requests never comes back.
  relay.setClosingSockets(
    (filter) =>
      Array.isArray(filter?.kinds) &&
      filter.kinds.includes(47003) &&
      Array.isArray(filter?.["#e"]),
  );
  await install(page, relay, null);
  await page.goto("/work");
  const open = page.getByTestId("work-open");
  await expect(open.getByTestId("work-open-failed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(open.getByTestId("work-open-item")).toHaveCount(0);
  await expect(open.getByTestId("work-open-empty")).toHaveCount(0);
  relay.setClosingSockets(false);
  await open.getByRole("button", { name: "Try again" }).click();
  await expect(open.getByTestId("work-open-item")).toHaveCount(2, {
    timeout: 30_000,
  });
});

test("at 390px the Work page fits with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seedRequests(relay);
  await install(page, relay, null);
  await page.goto("/work");
  await expect(page.getByTestId("work-open-item")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
