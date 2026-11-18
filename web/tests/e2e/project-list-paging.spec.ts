import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * The list of every project on a busy server. Project records are read on their own, a page at a time, so however
 * much news the server holds, no project is pushed out of Discover or Home's side panel by it; older projects are one
 * "Show more projects" away; and a later page that fails keeps what was already shown, with a retry.
 */

const FOUNDER = pubkeyOf("b1".repeat(32));
const PAGE = 300;
const EXTRA = 20;

/** More projects than one page holds, and more news, all newer than any project, than one read holds. */
function seedBusyServer(relay: Relay) {
  const base = now() - 10_000;
  for (let i = 0; i < PAGE + EXTRA; i += 1) {
    const oldest = i === PAGE + EXTRA - 1;
    relay.seed(
      projectRecord(
        FOUNDER,
        `p${i}`,
        oldest ? "Oldest One" : `Project ${String(i).padStart(3, "0")}`,
        base - i,
      ),
    );
  }
  for (let i = 0; i < 600; i += 1)
    relay.seed(
      event(
        47003,
        FOUNDER,
        { title: `News ${i}`, body: "Still going." },
        [
          ["a", coordOf(FOUNDER, "p0")],
          ["update-kind", "weekly"],
        ],
        now() - i,
      ),
    );
}

test("news never pushes projects out: Discover and Home list them, and older ones are one press away", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay();
  seedBusyServer(relay);
  await install(page, relay, null);

  // Home's side panel lists the newest projects although 600 newer records of another kind are on the server.
  await page.goto("/");
  await expect(
    page
      .getByTestId("social-rail-projects")
      .getByText("Project 000", { exact: true }),
  ).toBeVisible();

  await page.goto("/discover");
  const list = page.getByTestId("discover-launch-list");
  await expect(list.getByText("Project 000", { exact: true })).toBeVisible();
  await expect(list.getByTestId("discover-launch")).toHaveCount(PAGE);
  await expect(list.getByText("Oldest One")).toHaveCount(0);
  // Not "300 listed": the page says it has not reached the end.
  await expect(page.getByText(`${PAGE} shown so far`)).toBeVisible();
  // The news read came back full, and that is said rather than passed off as everything.
  await expect(page.getByTestId("more-projects-news-cut")).toBeVisible();

  // Every read of project records asked for that kind alone, with a limit.
  const pageReads = relay
    .reqsReceived()
    .flat()
    .filter((filter) => filter.kinds?.includes(37001) && filter.limit === PAGE);
  expect(pageReads.length).toBeGreaterThan(0);
  for (const filter of pageReads) expect(filter.kinds).toEqual([37001]);

  await page.getByTestId("more-projects").click();
  await expect(list.getByText("Oldest One", { exact: true })).toBeVisible();
  await expect(list.getByTestId("discover-launch")).toHaveCount(PAGE + EXTRA);
  await expect(page.getByText(`${PAGE + EXTRA} listed`)).toBeVisible();
  // The end was reached: nothing more is offered.
  await expect(page.getByTestId("more-projects")).toHaveCount(0);
});

test("a later page that fails keeps the projects already shown, and Try again reads it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay();
  seedBusyServer(relay);
  await install(page, relay, null);
  await page.goto("/discover");
  const list = page.getByTestId("discover-launch-list");
  await expect(list.getByTestId("discover-launch")).toHaveCount(PAGE);

  // The server hangs up on the read of the second page (the only read of project records that names `until`).
  relay.setClosingSockets(
    (filter) =>
      Boolean(filter?.kinds?.includes(37001)) &&
      typeof filter?.until === "number",
  );
  await page.getByTestId("more-projects").click();
  await expect(page.getByTestId("more-projects-failed")).toContainText(
    "Couldn't load more projects.",
    { timeout: 60_000 },
  );
  // Nothing already shown was taken away, and the page does not claim to be complete.
  await expect(list.getByTestId("discover-launch")).toHaveCount(PAGE);
  await expect(list.getByText("Project 000", { exact: true })).toBeVisible();
  await expect(page.getByText(`${PAGE} shown so far`)).toBeVisible();
  await expect(page.getByTestId("discover-load-error")).toHaveCount(0);

  relay.setClosingSockets(false);
  await page.getByTestId("more-projects-retry").click();
  await expect(list.getByText("Oldest One", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("more-projects-failed")).toHaveCount(0);
});
