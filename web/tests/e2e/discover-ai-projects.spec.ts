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
 * Finding AI projects, and ranking by promises kept rather than money: the category row always offers "AI agent or
 * tool" (and lists projects filed under the older "AI agents"), the default order pairs weeks in a row with kept
 * promises so a bare weekly post cannot climb, and a card carries the project's stored one line and a plain
 * promises-kept count with no score.
 */

const A = pubkeyOf("c1".repeat(32));
const B = pubkeyOf("c2".repeat(32));
const C = pubkeyOf("c3".repeat(32));
const D = pubkeyOf("c4".repeat(32));
const WEEK = 7 * DAY;

const update = (
  by: string,
  coord: string,
  title: string,
  tags: string[][],
  at: number,
) => event(47003, by, { title, body: "" }, [["a", coord], ...tags], at);
const weekly = (tags: string[][] = []) => [["update-kind", "weekly"], ...tags];

function seed(relay: Relay) {
  // Atlas: an AI tool, four weeks in a row, two promises made and both kept.
  const atlas = coordOf(A, "atlas");
  relay.seed(
    projectRecord(A, "atlas", "Atlas", now() - 10 * WEEK, {
      tags: [["t", "ai agent or tool"]],
    }),
  );
  const first = update(
    A,
    atlas,
    "Three weeks ago",
    weekly([
      ["update-part", "line", "Started the agent that sorts incoming mail."],
      ["promise", "0", "Sort a hundred emails"],
      ["promise", "1", "Write down every mistake"],
    ]),
    now() - 3 * WEEK,
  );
  relay.seed(first);
  relay.seed(
    update(
      A,
      atlas,
      "Two weeks ago",
      weekly([
        ["update-part", "line", "The agent sorted 100 emails with 7 mistakes."],
        ["promise-mark", `${first.id}:0`, "done", ""],
        ["promise-mark", `${first.id}:1`, "done", ""],
      ]),
      now() - 2 * WEEK,
    ),
  );
  relay.seed(
    update(
      A,
      atlas,
      "Last week",
      weekly([["update-part", "line", "Fixed the five worst mistakes."]]),
      now() - WEEK,
    ),
  );
  relay.seed(
    update(
      A,
      atlas,
      "This week",
      weekly([["update-part", "line", "Ten people now use it every morning."]]),
      now() - 3600,
    ),
  );

  // Birch: filed under the older topic, and posts a bare weekly update in each of the last six weeks.
  relay.seed(
    projectRecord(B, "birch", "Birch", now() - 8 * WEEK, {
      tags: [["t", "ai agents"]],
    }),
  );
  for (let week = 0; week < 6; week += 1)
    relay.seed(
      update(
        B,
        coordOf(B, "birch"),
        `Week ${week}`,
        weekly([["update-part", "line", "Done."]]),
        now() - week * WEEK - 3600,
      ),
    );

  // Cedar: no category. One promise made last week and kept this week; only one answered.
  const cedar = coordOf(C, "cedar");
  relay.seed(projectRecord(C, "cedar", "Cedar", now() - 3 * WEEK));
  const cedarFirst = update(
    C,
    cedar,
    "Last week",
    weekly([
      ["update-part", "line", "Drew the first three screens of the app."],
      ["promise", "0", "Build the first screen"],
    ]),
    now() - WEEK,
  );
  relay.seed(cedarFirst);
  relay.seed(
    update(
      C,
      cedar,
      "This week",
      weekly([
        [
          "update-part",
          "line",
          "Built the first screen and showed it to five people.",
        ],
        ["promise-mark", `${cedarFirst.id}:0`, "done", ""],
      ]),
      now() - 7200,
    ),
  );

  // Dune: no category, newest of all, one real update and no promises.
  relay.seed(projectRecord(D, "dune", "Dune", now() - DAY));
  relay.seed(
    update(
      D,
      coordOf(D, "dune"),
      "Hello",
      weekly([
        ["update-part", "line", "Opened the project and wrote down the goal."],
      ]),
      now() - 600,
    ),
  );
}

const rows = (page: import("@playwright/test").Page) =>
  page.getByTestId("project-board").getByTestId("project-board-row");
const names = (page: import("@playwright/test").Page) =>
  rows(page).evaluateAll((list) =>
    list.map((row) => row.querySelector(".font-bold")?.textContent?.trim()),
  );

test("the default order pairs weeks in a row with kept promises; a bare weekly post cannot climb, and no money is read", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await install(page, relay, null);
  await page.goto("/discover");
  const board = page.getByTestId("project-board");
  await expect(board.getByTestId("project-board-tab-reliable")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(board.getByTestId("project-board-note")).toContainText(
    "weeks posted in a row and promises kept",
  );
  // Atlas: a run that is paired with two kept promises. Cedar: one kept. Dune: a real update, nothing answered.
  // Birch has six weeks in a row of "Done." and is not here at all.
  await expect.poll(() => names(page)).toEqual(["Atlas", "Cedar", "Dune"]);
  const atlas = rows(page).filter({ hasText: "Atlas" });
  await expect(atlas.getByTestId("project-board-facts")).toContainText(
    "4 weeks in a row",
  );
  await expect(atlas.getByTestId("project-board-facts")).toContainText(
    "2 of 2 promises kept",
  );
  await expect(atlas.getByTestId("project-board-line")).toHaveText(
    "Ten people now use it every morning.",
  );
  await expect(board).not.toContainText(/\$|price|raised|earn/i);

  // The same six weeks are still shown for what they are: posted every week, nothing answered.
  await board.getByTestId("project-board-tab-moving").click();
  const birch = rows(page).filter({ hasText: "Birch" });
  await expect(birch.getByTestId("project-board-facts")).toContainText(
    "6 weeks in a row",
  );
  await expect(birch.getByTestId("project-board-facts")).not.toContainText(
    "promises kept",
  );
});

test("the AI chip is always offered, lists the older 'AI agents' topic too, and each card carries the stored line and kept count", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await install(page, relay, null);
  await page.goto("/discover");
  const browse = page.getByTestId("category-browse");
  // Only two of the four projects carry a category, and the whole fixed set shows.
  for (const slug of [
    "software",
    "ai-agent-or-tool",
    "creative",
    "community",
    "other",
  ])
    await expect(browse.getByTestId(`category-${slug}`)).toBeVisible();
  // The older topic is not a second chip.
  await expect(browse.getByRole("tab", { name: "AI agents" })).toHaveCount(0);

  await browse.getByTestId("category-ai-agent-or-tool").click();
  const grid = browse.getByTestId("category-grid");
  await expect(grid.getByTestId("discover-launch")).toHaveCount(2);
  const atlas = grid
    .getByTestId("discover-launch")
    .filter({ hasText: "Atlas" });
  await expect(atlas.getByTestId("project-record-summary")).toHaveText(
    "Ten people now use it every morning.",
  );
  await expect(atlas.getByTestId("project-record-facts")).toHaveText(
    "4 weeks in a row2 of 2 promises kept",
  );
  // Birch is filed under the older topic and shows its own line, with no promise count: it answered none.
  const birch = grid
    .getByTestId("discover-launch")
    .filter({ hasText: "Birch" });
  await expect(birch.getByTestId("project-record-summary")).toHaveText("Done.");
  await expect(birch.getByTestId("project-record-facts")).not.toContainText(
    "promises kept",
  );
  await expect(grid).not.toContainText("Cedar");

  // A kind nobody has filed yet is a real chip with an honest empty page.
  await browse.getByTestId("category-creative").click();
  await expect(grid).toContainText("Nothing filed under this topic yet");
});

test("the main list's cards carry the same line and count, and a project with no update shows neither", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  relay.seed(
    projectRecord(pubkeyOf("c5".repeat(32)), "echo", "Echo", now() - 2 * WEEK),
  );
  await install(page, relay, null);
  await page.goto("/discover");
  const list = page.getByTestId("discover-launch-list");
  const cedar = list
    .getByTestId("discover-launch")
    .filter({ hasText: "Cedar" });
  await expect(cedar.getByTestId("project-record-summary")).toHaveText(
    "Built the first screen and showed it to five people.",
  );
  await expect(cedar.getByTestId("project-record-facts")).toContainText(
    "1 of 1 promise kept",
  );
  const echo = list.getByTestId("discover-launch").filter({ hasText: "Echo" });
  await expect(echo).toBeVisible();
  await expect(echo.getByTestId("project-record-line")).toHaveCount(0);
});

test("at 390px the category row and the cards fit with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay);
  await install(page, relay, null);
  await page.goto("/discover");
  await page.getByTestId("category-ai-agent-or-tool").click();
  await expect(page.getByTestId("category-grid")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
