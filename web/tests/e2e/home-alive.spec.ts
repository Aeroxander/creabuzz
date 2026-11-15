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
 * Home on a quiet server: a project's start is an item you can wish luck on, "Just started" lists who began this week,
 * the update-day rail counts who has posted and who is due, and "This week on Creaton" sums the week from week two.
 * Cheers are about records only. "See a record" opens the server's own project, which also leads the follow list.
 */

const READER_KEY = "a1".repeat(32);
const READER = pubkeyOf(READER_KEY);
const ASTER_KEY = "a2".repeat(32);
const ASTER = pubkeyOf(ASTER_KEY);
const BASIL = pubkeyOf("a3".repeat(32));
const CEDAR = pubkeyOf("a4".repeat(32));
const DUNE = pubkeyOf("a5".repeat(32));
const OWNER = pubkeyOf("a6".repeat(32));
const SERVER = pubkeyOf("a7".repeat(32));
const ELM = pubkeyOf("a8".repeat(32));

const update = (
  by: string,
  coord: string,
  title: string,
  tags: string[][],
  at: number,
) => event(47003, by, { title, body: "" }, [["a", coord], ...tags], at);

const goal = (
  by: string,
  coord: string,
  state: string,
  at: number,
  level = "primary",
  id = "g1abcdef",
) =>
  update(
    by,
    coord,
    "Goal",
    [
      ["goal", id],
      ["goal-level", level],
      ["goal-text", "Ten people sign in"],
      ["goal-how", "Ten sign-ins"],
      ["goal-state", state],
      ...(state === "missed" ? [["goal-reason", "Only six came."]] : []),
    ],
    at,
  );

const cards = (page: import("@playwright/test").Page) =>
  page.getByTestId("record-feed").getByTestId("record-card");

function quietServer(relay: Relay) {
  // Aster: started two days ago with a goal, nothing else. Its start is a card on the feed.
  relay.seed(projectRecord(ASTER, "aster", "Aster", now() - 2 * DAY));
  relay.seed(
    goal(ASTER, coordOf(ASTER, "aster"), "open", now() - 2 * DAY + 60),
  );
  // Basil: started yesterday, no goal and no update. It is on the strip.
  relay.seed(projectRecord(BASIL, "basil", "Basil", now() - DAY));
  // Cedar: started yesterday with a goal, but its founder chose "Not listed yet". Nowhere on Home.
  relay.seed(
    projectRecord(CEDAR, "cedar", "Cedar", now() - DAY, {
      content: { listing: "unlisted" },
    }),
  );
  relay.seed(goal(CEDAR, coordOf(CEDAR, "cedar"), "open", now() - DAY + 60));
  // Dune: started three days ago and already posted. Not "just started".
  relay.seed(projectRecord(DUNE, "dune", "Dune", now() - 3 * DAY));
  relay.seed(
    update(
      DUNE,
      coordOf(DUNE, "dune"),
      "First week",
      [["update-part", "done", "Set up the repository. Wrote the plan."]],
      now() - DAY,
    ),
  );
}

test("a project's start is a card with Follow and Good luck, and a count shows from the first cheer only", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  quietServer(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");

  const started = cards(page).filter({ hasText: "Aster" });
  await expect(started).toHaveCount(1);
  await expect(started.getByTestId("record-card-label")).toHaveText(
    "Just started",
  );
  await expect(started.getByTestId("record-card-started")).toContainText(
    "Goal: Ten people sign in",
  );
  await expect(started.getByTestId("record-card-started")).toContainText(
    "How we'll know: Ten sign-ins",
  );
  await expect(started.getByTestId("record-card-follow")).toBeVisible();
  const luck = started.getByTestId("record-card-cheer");
  await expect(luck).toContainText("Good luck");
  // No count before the first cheer.
  await expect(started.getByTestId("record-card-cheers")).toHaveCount(0);

  // A project nobody can list is announced nowhere: no card, no strip entry. Dune posted, so it is not "just started".
  await expect(cards(page).filter({ hasText: "Cedar" })).toHaveCount(0);
  const strip = page.getByTestId("just-started");
  await expect(strip.getByTestId("just-started-item")).toHaveCount(1);
  await expect(strip).toContainText("Basil");
  // Not said twice: Aster has its card, so it is not on the strip.
  await expect(strip).not.toContainText("Aster");
  await expect(strip).not.toContainText("Cedar");
  await expect(strip).not.toContainText("Dune");

  await expectAccessible(page, "Home's Updates tab on a quiet server");

  await luck.click();
  await expect(luck).toContainText("Good luck sent");
  await expect(luck).toBeDisabled();
  await expect(started.getByTestId("record-card-cheers")).toHaveText("1");
  const sent = () =>
    relay.events.filter((e) => e.kind === 7 && e.pubkey === READER);
  await expect.poll(() => sent().length).toBe(1);
  const reaction = sent()[0];
  expect(reaction.content).toBe("+");
  expect(reaction.tags).toContainEqual(["p", ASTER]);
  expect(reaction.tags).toContainEqual(["k", "47003"]);
  expect(reaction.tags).toContainEqual(["a", coordOf(ASTER, "aster")]);
  // A cheer is about the record: nothing in it speaks of Shares, a price or money.
  expect(JSON.stringify(reaction)).not.toMatch(/share|price|amount|usdc/i);
  await expect(page.getByTestId("record-feed")).not.toContainText(/earn/i);
});

test("a founder is not asked to wish themselves luck, and a project removed by its founder is not announced", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  quietServer(relay);
  // Removed by its founder: the record's own deletion, which hides the project and everything about it.
  const gone = projectRecord(ELM, "elm", "Elm", now() - DAY);
  relay.seed(gone);
  relay.seed(goal(ELM, coordOf(ELM, "elm"), "open", now() - DAY + 60));
  relay.seed(event(5, ELM, "", [["a", coordOf(ELM, "elm")]], now() - 3600));
  await install(page, relay, ASTER_KEY);
  await page.goto("/?tab=updates");
  // Aster is the reader's own project: its start is shown, with no "Good luck" and no Follow.
  const own = cards(page).filter({ hasText: "Aster" });
  await expect(own).toHaveCount(1);
  await expect(own.getByTestId("record-card-cheer")).toHaveCount(0);
  await expect(page.getByTestId("record-feed")).not.toContainText("Elm");
  await expect(page.getByTestId("just-started")).not.toContainText("Elm");
  // Their own project is not on the strip either: they were told when they started it.
  await expect(page.getByTestId("just-started")).not.toContainText("Aster");
});

test("an honest miss is thanked, a first update and a goal reached are cheered", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const coord = coordOf(DUNE, "dune");
  relay.seed(projectRecord(DUNE, "dune", "Dune", now() - 30 * DAY));
  const first = update(
    DUNE,
    coord,
    "Week one",
    [
      ["update-part", "done", "Set up the repository."],
      ["promise", "0", "Write the plan"],
    ],
    now() - 14 * DAY,
  );
  relay.seed(first);
  relay.seed(
    update(
      DUNE,
      coord,
      "Week two",
      [
        ["update-part", "done", "The plan is not written."],
        ["promise-mark", `${first.id}:0`, "not-done", "Ran out of time."],
      ],
      now() - 7 * DAY,
    ),
  );
  relay.seed(goal(DUNE, coord, "reached", now() - 2 * DAY, "week", "g2abcdef"));
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");

  const miss = cards(page).filter({ hasText: "Week two" });
  await expect(miss.getByTestId("record-card-cheer")).toContainText(
    "Thanks for saying so",
  );
  const firstCard = cards(page).filter({ hasText: "Week one" });
  await expect(firstCard.getByTestId("record-card-label")).toHaveText(
    "First update",
  );
  await expect(firstCard.getByTestId("record-card-cheer")).toContainText(
    "Cheer",
  );
  const done = cards(page).filter({ hasText: "Ten people sign in" });
  await expect(done.getByTestId("record-card-label")).toHaveText(
    "Goal reached",
  );
  await expect(done.getByTestId("record-card-cheer")).toContainText("Cheer");

  await miss.getByTestId("record-card-cheer").click();
  await expect(miss.getByTestId("record-card-cheer")).toContainText(
    "Thanks sent",
  );
  await expect(miss.getByTestId("record-card-cheers")).toHaveText("1");
});

test("the founder reads one line about cheers per project and day, batched, and never about money", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const coord = coordOf(ASTER, "aster");
  relay.seed(projectRecord(ASTER, "aster", "Aster", now() - 3 * DAY));
  const start = goal(ASTER, coord, "open", now() - 3 * DAY + 60);
  relay.seed(start);
  for (const [who, n] of [
    [BASIL, 1],
    [CEDAR, 2],
    [DUNE, 3],
  ] as const)
    relay.seed(
      event(
        7,
        who,
        "+",
        [
          ["e", start.id],
          ["p", ASTER],
          ["k", "47003"],
          ["a", coord],
        ],
        now() - n * 60,
      ),
    );
  // A like on an ordinary post is not a cheer.
  relay.seed(
    event(
      7,
      BASIL,
      "+",
      [
        ["e", "f".repeat(64)],
        ["p", ASTER],
        ["k", "1"],
      ],
      now() - 30,
    ),
  );
  await install(page, relay, ASTER_KEY);
  await page.goto("/");
  const line = page.getByTestId("home-cheers-line");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText("3 people cheered Aster today.");
  await expect(page.getByTestId("home-cheers")).not.toContainText(
    /share|price|money/i,
  );
});

test("the update-day rail counts who has posted and who is due, and takes a founder to their own update", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  // Started 41 days ago, a multiple of a week plus a day: their update day was yesterday.
  const old = now() - 41 * DAY;
  const posted = (founder: string, id: string, name: string) => {
    relay.seed(projectRecord(founder, id, name, old));
    relay.seed(
      update(
        founder,
        coordOf(founder, id),
        "This week",
        [["update-part", "done", "Did the work."]],
        now() - 10,
      ),
    );
  };
  posted(ASTER, "aster", "Aster");
  posted(BASIL, "basil", "Basil");
  // Due: the last update came before the update day, or there never was one.
  relay.seed(projectRecord(CEDAR, "cedar", "Cedar", old));
  relay.seed(
    update(
      CEDAR,
      coordOf(CEDAR, "cedar"),
      "Old",
      [["update-kind", "weekly"]],
      now() - 9 * DAY,
    ),
  );
  relay.seed(projectRecord(DUNE, "dune", "Dune", old));
  // The reader's own project, due.
  relay.seed(projectRecord(READER, "mine", "Mine", old));
  relay.seed(
    update(
      READER,
      coordOf(READER, "mine"),
      "Old",
      [["update-kind", "weekly"]],
      now() - 9 * DAY,
    ),
  );
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const rail = page.getByTestId("update-day-rail");
  await expect(rail.getByTestId("update-day-words")).toContainText(
    "2 projects have posted, 3 are due.",
  );
  await expect(rail).not.toContainText(/late|missed|overdue/i);
  const post = rail.getByRole("link", { name: "Post your update" });
  await expect(post).toHaveCount(1);
  await expect(post).toHaveAttribute("href", /action=update/);
  await expect(post).toHaveAttribute("href", /\/launchpad\/mine/);
});

test("this week on Creaton shows from week two, from the signed records, never as a zero week", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  const coord = coordOf(DUNE, "dune");
  relay.seed(projectRecord(DUNE, "dune", "Dune", now() - 30 * DAY));
  const old = update(
    DUNE,
    coord,
    "Early",
    [
      ["update-part", "done", "Started."],
      ["promise", "0", "Ship it"],
      ["promise", "1", "Write it"],
    ],
    now() - 10 * DAY,
  );
  relay.seed(old);
  relay.seed(
    update(
      DUNE,
      coord,
      "Answers",
      [
        ["update-part", "done", "Shipped it."],
        ["promise-mark", `${old.id}:0`, "done", ""],
        ["promise-mark", `${old.id}:1`, "not-done", "No time."],
      ],
      now() - 2 * DAY,
    ),
  );
  relay.seed(
    update(DUNE, coord, "Plain", [["update-kind", "weekly"]], now() - DAY),
  );
  // One new project this week.
  relay.seed(projectRecord(BASIL, "basil", "Basil", now() - 3 * DAY));
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const week = page.getByTestId("week-in-review");
  await expect(week).toContainText("This week on Creaton");
  await expect(week.getByTestId("week-in-review-line")).toHaveText([
    "2 updates posted",
    "1 promise kept",
    "1 promise missed",
    "1 new project",
  ]);
});

test("there is no week in review in a server's first week, nor for a week with nothing in it", async ({
  page,
}) => {
  const first = createMockRelay({ applyDeletions: true });
  first.seed(projectRecord(DUNE, "dune", "Dune", now() - 3 * DAY));
  first.seed(
    update(
      DUNE,
      coordOf(DUNE, "dune"),
      "Hello",
      [["update-kind", "weekly"]],
      now() - DAY,
    ),
  );
  await install(page, first, READER_KEY);
  await page.goto("/?tab=updates");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId("week-in-review")).toHaveCount(0);

  const quiet = createMockRelay({ applyDeletions: true });
  quiet.seed(projectRecord(DUNE, "dune", "Dune", now() - 30 * DAY));
  quiet.seed(
    update(
      DUNE,
      coordOf(DUNE, "dune"),
      "Old",
      [["update-kind", "weekly"]],
      now() - 12 * DAY,
    ),
  );
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await install(page, quiet, READER_KEY);
  await page.goto("/?tab=updates");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId("week-in-review")).toHaveCount(0);
  await expect(page.getByTestId("record-feed")).not.toContainText(
    /0 updates|0 new projects/,
  );
});

test("'See a record' opens the server's own project, which is also first in the newcomer's follow list", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  // The server's member list names its owner; the owner's project is the example. It is quiet and old.
  relay.seed(
    event(
      13534,
      SERVER,
      "",
      [
        ["member", OWNER, "owner"],
        ["member", ASTER, "member"],
      ],
      now() - 40 * DAY,
    ),
  );
  relay.seed(projectRecord(OWNER, "creaton", "Creaton", now() - 40 * DAY));
  // A busier project, which would lead the list otherwise.
  relay.seed(projectRecord(ASTER, "aster", "Aster", now() - 5 * DAY));
  for (const ago of [0, 1, 2])
    relay.seed(
      update(
        ASTER,
        coordOf(ASTER, "aster"),
        "Day",
        [["update-kind", "weekly"]],
        now() - ago * DAY - 120,
      ),
    );
  await install(page, relay, null);
  await page.goto("/");
  const link = page.getByTestId("home-welcome-record");
  await expect(link).toHaveText("See a record");
  await expect(link).toHaveAttribute("href", /^\/p\/creaton-[0-9a-f]{16}$/);
  await link.click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Creaton",
  );

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await install(page, relay, "a9".repeat(32));
  await page.goto("/");
  const welcome = page.getByTestId("newcomer-welcome");
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByTestId("welcome-follow-some").click();
  const items = welcome.getByTestId("welcome-follow-item");
  await expect(items.nth(0)).toContainText("Creaton");
  await expect(items.nth(1)).toContainText("Aster");
});

test("without an owner's project there is no 'See a record'", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(ASTER, "aster", "Aster", now() - 5 * DAY));
  await install(page, relay, null);
  await page.goto("/");
  await expect(page.getByTestId("home-welcome")).toBeVisible();
  await expect(page.getByTestId("home-welcome-record")).toHaveCount(0);
});

test("a server that names its example project offers 'See a record' when the lists show none", async ({
  page,
}) => {
  // No owner is on the member list (as for a visitor an invite-only server does not let read it), so the page cannot
  // find the owner's project itself. The server's information document names one.
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(ASTER, "aster", "Aster", now() - 5 * DAY));
  await install(page, relay, null);
  const named = `aster-${ASTER.slice(0, 16)}`;
  await page.route("**/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({ name: "Mock server", example_project: named }),
    }),
  );
  await page.goto("/");
  const link = page.getByTestId("home-welcome-record");
  await expect(link).toHaveText("See a record");
  await expect(link).toHaveAttribute("href", `/p/${named}`);

  // Something that is not a project's address is not offered.
  await page.unroute("**/info");
  await page.route("**/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({ example_project: "/u/someone" }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId("home-welcome")).toBeVisible();
  await expect(page.getByTestId("home-welcome-record")).toHaveCount(0);
});

test("'Copy update link' copies the project's scorecard address", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(DUNE, "dune", "Dune", now() - 20 * DAY));
  relay.seed(
    update(
      DUNE,
      coordOf(DUNE, "dune"),
      "Hello",
      [["update-part", "done", "Said hello."]],
      now() - DAY,
    ),
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  await cards(page)
    .filter({ hasText: "Hello" })
    .getByRole("button", { name: "Copy update link" })
    .click();
  await expect(page.getByTestId("record-feed-message")).toHaveText(
    "Update link copied.",
  );
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).pathname).toBe(`/p/dune-${DUNE.slice(0, 16)}`);
  expect(new URL(copied).search).toBe("");
});

test("Home's update card shows the stored one line", async ({ page }) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(DUNE, "dune", "Dune", now() - 20 * DAY));
  relay.seed(
    update(
      DUNE,
      coordOf(DUNE, "dune"),
      "Week",
      [
        [
          "update-part",
          "done",
          "Shipped the importer. Then fixed three bugs. Then slept.",
        ],
        ["update-part", "line", "The importer ships."],
      ],
      now() - DAY,
    ),
  );
  relay.seed(
    update(
      DUNE,
      coordOf(DUNE, "dune"),
      "Later",
      [["update-part", "done", "Fixed three bugs. Wrote tests for them."]],
      now() - 3600,
    ),
  );
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  const lines = page.getByTestId("record-card-line");
  // The sentence the author signed, and otherwise the first sentence of what happened.
  await expect(lines).toHaveText(["Fixed three bugs.", "The importer ships."]);
});

test("a founder's run is marked, in neutral words, once the update is due and this week has no update", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  const coord = coordOf(READER, "mine");
  // Started on today's weekday, four weeks ago: the update day is today. Updates seven and fourteen days ago are last
  // week and the week before, whatever today is, so the run is two weeks and nothing is posted this week.
  relay.seed(projectRecord(READER, "mine", "Mine", now() - 28 * DAY));
  for (const ago of [14, 7])
    relay.seed(
      update(
        READER,
        coord,
        "Week",
        [["update-kind", "weekly"]],
        now() - ago * DAY,
      ),
    );
  await install(page, relay, READER_KEY);
  await page.goto("/portfolio");
  const risk = page.getByTestId("your-project-streak-risk");
  await expect(risk).toHaveText(
    "An update this week keeps your run of 2 weeks going.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("your-project-streak")).toHaveText(
    "2 weeks in a row",
  );
  await expect(risk).not.toContainText(/lose|lost|break|late|miss|risk/i);

  // Posted this week: the run goes on and nothing is marked.
  relay.seed(
    update(READER, coord, "Now", [["update-kind", "weekly"]], now() - 10),
  );
  await page.reload();
  await expect(page.getByTestId("your-project-streak")).toHaveText(
    "3 weeks in a row",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("your-project-streak-risk")).toHaveCount(0);
});

test("at 390px the rail, the strip, the start card and the week fit with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  quietServer(relay);
  relay.seed(projectRecord(OWNER, "creaton", "Creaton", now() - 30 * DAY));
  relay.seed(
    update(
      OWNER,
      coordOf(OWNER, "creaton"),
      "Hello",
      [["update-kind", "weekly"]],
      now() - DAY,
    ),
  );
  await install(page, relay, READER_KEY);
  await page.goto("/?tab=updates");
  await expect(page.getByTestId("update-day-rail")).toBeVisible();
  await expect(page.getByTestId("just-started")).toBeVisible();
  await expect(page.getByTestId("week-in-review")).toBeVisible();
  await expect(cards(page).filter({ hasText: "Aster" })).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
