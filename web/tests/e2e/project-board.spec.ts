import { expect, test } from "@playwright/test";

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

/**
 * The Projects page as a scoreboard: Moving now, New, Most kept promises, Looking for help. Each row is a project
 * with its streak of weekly updates, promises kept of answered, open requests and followers, and one tap opens it.
 * Only the project's own people's records score; a record dated before the project existed earns nothing; and a
 * project started with the short form is a project, with no "Idea" label.
 */

const A = pubkeyOf("b1".repeat(32));
const B = pubkeyOf("b2".repeat(32));
const C = pubkeyOf("b3".repeat(32));
const D = pubkeyOf("b4".repeat(32));
const FAN = pubkeyOf("b5".repeat(32));
const STRANGER = pubkeyOf("b6".repeat(32));
const WEEK = 7 * DAY;

const update = (
  by: string,
  coord: string,
  title: string,
  tags: string[][],
  at: number,
) => event(47003, by, { title, body: "" }, [["a", coord], ...tags], at);

function seedBoard(relay: Relay) {
  const atlas = coordOf(A, "atlas");
  relay.seed(projectRecord(A, "atlas", "Atlas", now() - 10 * WEEK));
  relay.seed(projectRecord(B, "birch", "Birch", now() - 5 * WEEK));
  relay.seed(projectRecord(C, "cedar", "Cedar", now() - 3600));
  // Dune was first published yesterday.
  relay.seed(projectRecord(D, "dune", "Dune", now() - DAY));
  relay.seed(
    projectRecord(C, "quiet", "Quiet Work", now() - WEEK, {
      content: { listing: "unlisted" },
    }),
  );

  // Atlas: an update in each of the last three weeks; three promises, two kept and one missed.
  const first = update(
    A,
    atlas,
    "Two weeks ago",
    [
      ["update-part", "next", "One\nTwo\nThree"],
      ["promise", "0", "One"],
      ["promise", "1", "Two"],
      ["promise", "2", "Three"],
    ],
    now() - 2 * WEEK,
  );
  relay.seed(first);
  relay.seed(
    update(
      A,
      atlas,
      "Last week",
      [
        ["update-part", "done", "Did it."],
        ["promise-mark", `${first.id}:0`, "done", ""],
        ["promise-mark", `${first.id}:1`, "done", ""],
        ["promise-mark", `${first.id}:2`, "not-done", ""],
      ],
      now() - WEEK,
    ),
  );
  relay.seed(
    update(A, atlas, "This week", [["update-kind", "weekly"]], now() - 3600),
  );
  // Someone follows Atlas.
  relay.seed(event(10003, FAN, "", [["a", atlas]], now() - DAY));
  // A stranger's records about Atlas score nothing.
  for (let week = 3; week < 9; week += 1)
    relay.seed(
      update(
        STRANGER,
        atlas,
        "Fake week",
        [["update-kind", "weekly"]],
        now() - week * WEEK,
      ),
    );

  // Birch: posted on two days this week, and asks for help.
  relay.seed(
    update(
      B,
      coordOf(B, "birch"),
      "Monday",
      [["update-kind", "weekly"]],
      now() - 2 * DAY,
    ),
  );
  relay.seed(
    update(
      B,
      coordOf(B, "birch"),
      "Today",
      [
        ["help-needed", "A designer for the landing page."],
        ["help-size", "medium"],
      ],
      now() - 1800,
    ),
  );

  // Dune's founder signs one update today, and six more dated back across the weeks before the project existed.
  relay.seed(
    update(
      D,
      coordOf(D, "dune"),
      "Hello",
      [["update-kind", "weekly"]],
      now() - 600,
    ),
  );
  for (let week = 1; week <= 6; week += 1)
    relay.seed(
      update(
        D,
        coordOf(D, "dune"),
        `Backdated ${week}`,
        [["update-kind", "weekly"]],
        now() - week * WEEK,
      ),
    );
}

const rows = (page: import("@playwright/test").Page) =>
  page.getByTestId("project-board").getByTestId("project-board-row");
const names = (page: import("@playwright/test").Page) =>
  rows(page).evaluateAll((list) =>
    list.map((row) => row.querySelector(".font-bold")?.textContent?.trim()),
  );

test("the scoreboard ranks by real activity, kept promises and open requests; one tap opens a project", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedBoard(relay);
  await install(page, relay, null);
  await page.goto("/discover");
  const board = page.getByTestId("project-board");
  await expect(board.getByTestId("project-board-tab-moving")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Moving now: days posted on this week, then the longer streak. Birch posted on two days; Atlas and Dune on one,
  // and Atlas has the streak. Cedar has posted nothing, and the project that is not listed is not here.
  await expect.poll(() => names(page)).toEqual(["Birch", "Atlas", "Dune"]);
  const atlas = rows(page).filter({ hasText: "Atlas" });
  await expect(atlas.getByTestId("project-board-facts")).toContainText(
    "3 weeks in a row",
  );
  await expect(atlas.getByTestId("project-board-facts")).toContainText(
    "2 of 3 promises kept",
  );
  await expect(atlas.getByTestId("project-board-facts")).toContainText(
    "1 follower",
  );
  // Six updates dated back before the project existed earn no streak.
  const dune = rows(page).filter({ hasText: "Dune" });
  await expect(dune.getByTestId("project-board-facts")).toContainText(
    "Posted this week",
  );
  await expect(dune.getByTestId("project-board-facts")).not.toContainText(
    "weeks in a row",
  );
  await expect(board).not.toContainText("Quiet Work");
  await expect(board).not.toContainText(/\$|price|earn/i);

  await board.getByTestId("project-board-tab-new").click();
  await expect
    .poll(() => names(page))
    .toEqual(["Cedar", "Dune", "Birch", "Atlas"]);
  await expect(
    rows(page).filter({ hasText: "Cedar" }).getByTestId("project-board-facts"),
  ).toHaveText("No updates yet");

  await board.getByTestId("project-board-tab-kept").click();
  await expect.poll(() => names(page)).toEqual(["Atlas"]);

  await board.getByTestId("project-board-tab-help").click();
  await expect.poll(() => names(page)).toEqual(["Birch"]);
  await expect(rows(page).first()).toContainText("1 open request for help");

  // A project started with the short form is a project: nothing on the page calls it an idea.
  await expect(page.getByTestId("launch-card-idea")).toHaveCount(0);

  await rows(page).first().getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Birch");
});

test("when the scores cannot be read the board says so, with a retry; the list of projects still shows", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedBoard(relay);
  relay.setClosingSockets(
    (filter) =>
      Array.isArray(filter?.kinds) &&
      filter.kinds.length === 1 &&
      filter.kinds[0] === 47003 &&
      Array.isArray(filter?.authors) &&
      Array.isArray(filter?.["#a"]) &&
      (filter["#a"] as string[]).length > 1,
  );
  await install(page, relay, null);
  await page.goto("/discover");
  const board = page.getByTestId("project-board");
  await expect(board.getByTestId("project-board-failed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(rows(page)).toHaveCount(0);
  await expect(
    page
      .getByTestId("discover-launch-list")
      .getByText("Atlas", { exact: true }),
  ).toBeVisible();
  relay.setClosingSockets(false);
  await board.getByRole("button", { name: "Try again" }).click();
  await expect
    .poll(() => names(page), { timeout: 30_000 })
    .toEqual(["Birch", "Atlas", "Dune"]);
});

test("at 390px the scoreboard fits with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seedBoard(relay);
  await install(page, relay, null);
  await page.goto("/discover");
  await expect(rows(page)).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
