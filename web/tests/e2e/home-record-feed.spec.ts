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

/**
 * Home's Updates tab as a feed of project records: updates, the founder's answers to earlier promises, goals reached
 * or missed, help wanted (answered from the card), and work accepted. One card per signed record, with the project's
 * name, newest first. A visitor, or someone tied to no project yet, reads every listed project and is told so;
 * someone who follows a project reads theirs. Only the party entitled to sign a record puts it in the feed.
 */

const FOUNDER_KEY = "d1".repeat(32);
const READER_KEY = "d2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const READER = pubkeyOf(READER_KEY);
const OTHER = pubkeyOf("d3".repeat(32));
const HELPER = pubkeyOf("d4".repeat(32));
const MATE = pubkeyOf("d5".repeat(32));
const STRANGER = pubkeyOf("d6".repeat(32));
const NEBULA = coordOf(FOUNDER, "nebula");
const ORBIT = coordOf(OTHER, "orbit");
const QUIET = coordOf(OTHER, "quiet");

const profile = (pubkey: string, name: string) =>
  event(0, pubkey, { name, display_name: name }, [], now() - 90 * DAY);
const update = (
  by: string,
  coord: string,
  title: string,
  tags: string[][],
  at: number,
  body = "",
) => event(47003, by, { title, body }, [["a", coord], ...tags], at);

function seedWorld(relay: Relay) {
  for (const [key, name] of [
    [FOUNDER, "Fay Founder"],
    [READER, "Rae Reader"],
    [OTHER, "Otto Other"],
    [HELPER, "Robin Helper"],
    [MATE, "Max Mate"],
  ])
    relay.seed(profile(key, name));
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - 60 * DAY, {
      tags: [
        ["team", MATE, "member"],
        ["p", MATE],
      ],
    }),
  );
  relay.seed(projectRecord(OTHER, "orbit", "Orbit", now() - 50 * DAY));
  relay.seed(
    projectRecord(OTHER, "quiet", "Quiet Work", now() - 40 * DAY, {
      content: { listing: "unlisted" },
    }),
  );

  // Nebula: a first update with two promises, then one that answers them and asks for help.
  const first = update(
    FOUNDER,
    NEBULA,
    "Week one",
    [
      ["update-part", "done", "Started the map."],
      ["update-part", "next", "Ship sign-up\nWrite the guide"],
      ["promise", "0", "Ship sign-up"],
      ["promise", "1", "Write the guide"],
    ],
    now() - 14 * DAY,
    "https://example.com/demo",
  );
  relay.seed(first);
  relay.seed(
    update(
      FOUNDER,
      NEBULA,
      "Week two: sign-up works",
      [
        ["update-part", "done", "Sign-up shipped on Tuesday."],
        ["promise-mark", `${first.id}:0`, "done", ""],
        ["promise-mark", `${first.id}:1`, "not-done", "No time."],
        ["help-needed", "Someone to test sign-up on an older phone."],
        ["help-size", "small"],
      ],
      now() - 7 * DAY,
    ),
  );
  // A goal the founder marked missed, with why.
  relay.seed(
    update(
      FOUNDER,
      NEBULA,
      "Goal",
      [
        ["goal", "g1abcdef"],
        ["goal-level", "week"],
        ["goal-text", "Ten people sign in this week"],
        ["goal-how", "Ten sign-ins"],
        ["goal-state", "missed"],
        ["goal-reason", "Only six came."],
      ],
      now() - 6 * DAY,
    ),
  );
  // Work: a task for the helper, handed in, confirmed by the second team member.
  const task = update(
    FOUNDER,
    NEBULA,
    "Task",
    [
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", HELPER],
      ["task-helper", HELPER],
      ["task-what", "Record sign-up on Android 9."],
      ["task-done", "A screen recording."],
      ["task-size", "small"],
    ],
    now() - 5 * DAY,
  );
  relay.seed(task);
  const step = (by: string, part: string, extra: string[][], at: number) =>
    update(
      by,
      NEBULA,
      part,
      [
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", task.id],
        ["task", task.id],
        ...extra,
      ],
      at,
    );
  relay.seed(step(HELPER, "accept", [], now() - 4 * DAY));
  const evidence = step(
    HELPER,
    "evidence",
    [["task-link", "https://example.org/recording"]],
    now() - 3 * DAY,
  );
  relay.seed(evidence);
  relay.seed(
    step(MATE, "confirm", [["task-evidence", evidence.id]], now() - 2 * DAY),
  );

  // A stranger signs an update and a "goal reached" naming Nebula. Neither is theirs to sign.
  relay.seed(
    update(
      STRANGER,
      NEBULA,
      "Fake official update",
      [["update-kind", "weekly"]],
      now() - DAY,
    ),
  );
  relay.seed(
    update(
      STRANGER,
      NEBULA,
      "Goal",
      [
        ["goal", "g2abcdef"],
        ["goal-level", "primary"],
        ["goal-text", "Forged goal reached"],
        ["goal-how", "x"],
        ["goal-state", "reached"],
      ],
      now() - DAY,
    ),
  );

  relay.seed(
    update(
      OTHER,
      ORBIT,
      "Orbit ships",
      [["update-part", "done", "The orbit demo is out."]],
      now() - 3600,
    ),
  );
  relay.seed(
    update(
      OTHER,
      QUIET,
      "Quiet progress",
      [["update-kind", "weekly"]],
      now() - 1800,
    ),
  );
}

const cards = (page: import("@playwright/test").Page) =>
  page.getByTestId("record-feed").getByTestId("record-card");

test("a visitor reads every listed project's records, one card each, and only from who may sign them", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, null);
  await page.goto("/?tab=updates");
  const feed = page.getByTestId("record-feed");
  await expect(feed.getByTestId("record-feed-scope")).toContainText(
    "This shows every listed project.",
  );
  await expect(feed.getByTestId("record-feed-scope")).toHaveAttribute(
    "data-mode",
    "everyone",
  );
  // Newest first, each with its project's name and what it is.
  await expect(cards(page)).toHaveCount(5);
  await expect(cards(page).nth(0)).toContainText("Orbit");
  await expect(cards(page).nth(0)).toContainText("Orbit ships");
  const work = cards(page).nth(1);
  await expect(work.getByTestId("record-card-label")).toHaveText(
    "Work accepted",
  );
  await expect(work).toContainText("Record sign-up on Android 9.");
  await expect(work).toContainText(
    "Done by Robin Helper. Checked by Max Mate.",
  );
  const goal = cards(page).nth(2);
  await expect(goal.getByTestId("record-card-label")).toHaveText("Goal missed");
  await expect(goal).toContainText("Ten people sign in this week");
  await expect(goal).toContainText("Only six came.");
  const second = cards(page).nth(3);
  await expect(second.getByTestId("record-card-label")).toHaveText(
    "Help wanted",
  );
  await expect(second.getByTestId("record-card-answers")).toHaveText(
    "Promises: 1 kept, 1 missed",
  );
  await expect(second.getByTestId("help-request")).toContainText(
    "Someone to test sign-up on an older phone.",
  );
  await expect(
    second.getByRole("button", { name: "I can help" }),
  ).toBeVisible();
  const first = cards(page).nth(4);
  await expect(first.getByTestId("record-card-label")).toHaveText("Update");
  await expect(first).toContainText(
    "What's next: Ship sign-up; Write the guide",
  );
  await expect(
    first.getByRole("link", { name: "Artifact 1 · example.com" }),
  ).toHaveAttribute("href", "https://example.com/demo");

  // What a stranger signed about the project is not in it, nor the project that is not listed.
  await expect(feed).not.toContainText("Fake official update");
  await expect(feed).not.toContainText("Forged goal reached");
  await expect(feed).not.toContainText("Quiet");
  // No price, amount or return on any card.
  await expect(feed).not.toContainText(/\$|Shares|earn/i);
  // Every card can be followed from.
  await expect(feed.getByRole("button", { name: "Follow Nebula" })).toHaveCount(
    4,
  );
  await expect(feed.getByRole("button", { name: "Follow Orbit" })).toHaveCount(
    1,
  );
  await expectAccessible(page, "Home's feed of project records");

  // The project's name opens its page.
  await cards(page).nth(2).getByTestId("record-card-project").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nebula");
});

test("someone new is told the feed is everyone's, follows a project from a card, and the feed becomes theirs", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const feed = page.getByTestId("record-feed");
  await expect(feed.getByTestId("record-feed-scope")).toContainText(
    "You follow no projects yet, so this shows every listed project.",
  );
  await expect(cards(page)).toHaveCount(5);
  await feed.getByRole("button", { name: "Follow Nebula" }).first().click();
  // The follow is a signed list of their own.
  await expect
    .poll(() =>
      relay.events.some(
        (e) =>
          e.kind === 10003 &&
          e.pubkey === READER &&
          e.tags.some((t) => t[0] === "a" && t[1] === NEBULA),
      ),
    )
    .toBe(true);
  // Now it is the reader's own feed: the project they follow, and nothing else.
  await expect(feed.getByTestId("record-feed-scope")).toHaveText(
    "From the projects you started, help or follow.",
  );
  await expect(cards(page)).toHaveCount(4);
  await expect(feed).not.toContainText("Orbit ships");
  await expect(feed.getByTestId("record-card-follow")).toHaveCount(0);
});

test("help wanted is answered from the card", async ({ page }) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  relay.seed(event(10003, READER, "", [["a", NEBULA]], now() - 30 * DAY));
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const card = cards(page).filter({ hasText: "Week two: sign-up works" });
  await card.getByRole("button", { name: "I can help" }).click();
  await card.getByRole("button", { name: "Send offer" }).click();
  await expect
    .poll(
      () =>
        relay.events.filter(
          (e) =>
            e.kind === 47003 &&
            e.pubkey === READER &&
            e.tags.some((t) => t[0] === "help-offer"),
        ).length,
    )
    .toBe(1);
  await expect(card.getByTestId("help-my-offer")).toBeVisible();
});

test("records this browser has not shown are marked new, and marking them read is one write", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  relay.seed(event(10003, READER, "", [["a", NEBULA]], now() - 30 * DAY));
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const feed = page.getByTestId("record-feed");
  await expect(cards(page)).toHaveCount(4);
  // Nothing is called new on a first visit: there is no earlier visit to compare with.
  await expect(feed.getByTestId("record-feed-new")).toHaveCount(0);
  await feed.getByTestId("record-feed-mark-read").click();
  await expect(feed.getByTestId("record-feed-message")).toHaveText(
    "The records shown here are marked as read in this browser.",
  );
  relay.seed(
    update(
      FOUNDER,
      NEBULA,
      "Week three",
      [["update-part", "done", "The guide is written."]],
      now() - 60,
    ),
  );
  await page.reload();
  await expect(feed.getByTestId("record-feed-new")).toHaveText("1 new to you");
  await expect(cards(page).first()).toContainText("New to you");
  await feed.getByTestId("record-feed-mark-read").click();
  await expect(feed.getByTestId("record-feed-new")).toHaveCount(0);
});

test("older records are a press away, and a page that fails keeps what was read", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - 60 * DAY));
  for (let i = 0; i < 130; i += 1)
    relay.seed(
      update(
        FOUNDER,
        NEBULA,
        `Note ${String(i).padStart(3, "0")}`,
        [["update-kind", "weekly"]],
        now() - 1000 - i * 60,
      ),
    );
  await install(page, relay, null);
  await page.goto("/?tab=updates");
  const feed = page.getByTestId("record-feed");
  await expect(cards(page)).toHaveCount(100);
  await expect(feed).not.toContainText("Note 129");

  relay.setClosingSockets(
    (filter) =>
      Boolean(filter?.kinds?.includes(47003)) &&
      Array.isArray(filter?.authors) &&
      typeof filter?.until === "number",
  );
  await feed.getByTestId("record-feed-more").click();
  await expect(feed.getByTestId("record-feed-more-failed")).toContainText(
    "Couldn't load older records.",
    { timeout: 60_000 },
  );
  await expect(cards(page)).toHaveCount(100);

  relay.setClosingSockets(false);
  await feed.getByTestId("record-feed-more-retry").click();
  await expect(cards(page)).toHaveCount(130, { timeout: 30_000 });
  await expect(feed).toContainText("Note 129");
  await expect(feed.getByTestId("record-feed-more")).toHaveCount(0);
});

test("signed in, a failure to read whose projects are theirs is said: everyone's records are not shown instead", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // The read of the reader's own project records never answers.
  relay.setClosingSockets(
    (filter) =>
      Boolean(filter?.kinds?.includes(37001)) &&
      Array.isArray(filter?.authors) &&
      (filter.authors as string[]).includes(READER) &&
      !filter?.["#d"],
  );
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const feed = page.getByTestId("record-feed");
  await expect(feed.getByTestId("record-feed-scope-failed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(cards(page)).toHaveCount(0);
  relay.setClosingSockets(false);
  await feed.getByRole("button", { name: "Try again" }).click();
  await expect(cards(page)).toHaveCount(5, { timeout: 30_000 });
});

test("at 390px the feed fits with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, null);
  await page.goto("/?tab=updates");
  await expect(cards(page)).toHaveCount(5);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("an update by someone the founder added is the project's only once that person has said yes", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - 60 * DAY, {
      tags: [
        ["team", MATE, "member"],
        ["team-invite", MATE, "inv1"],
        ["p", MATE],
      ],
    }),
  );
  relay.seed(
    update(
      FOUNDER,
      NEBULA,
      "From the founder",
      [["update-kind", "weekly"]],
      now() - 2 * DAY,
    ),
  );
  // The server lets the added person post at once. Until they say yes it is not the project speaking.
  relay.seed(
    update(
      MATE,
      NEBULA,
      "From someone added",
      [["update-kind", "weekly"]],
      now() - DAY,
    ),
  );
  await install(page, relay, null);
  await page.goto("/?tab=updates");
  const feed = page.getByTestId("record-feed");
  await expect(cards(page)).toHaveCount(1);
  await expect(feed).toContainText("From the founder");
  await expect(feed).not.toContainText("From someone added");

  relay.seed(
    event(
      47003,
      MATE,
      { title: "Joined the team", body: "" },
      [
        ["a", NEBULA],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 60,
    ),
  );
  await page.reload();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).first()).toContainText("From someone added");
});
