import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectPath,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * The weekly rhythm: everyone reads when a project's next update is due or how late it is; the founder's dialog
 * starts with what they promised last time (one tap each) and the work accepted since, takes at most three new
 * promises, and posting ends on a small note with the run so far and "Share your record".
 */

const ME_KEY = "c1".repeat(32);
const ME = pubkeyOf(ME_KEY);
const HELPER = pubkeyOf("c2".repeat(32));
const COORD = coordOf(ME, "rhythm");
const PAGE = projectPath(ME, "rhythm");

const record = (by: string, title: string, tags: string[][], at: number) =>
  event(47003, by, { title, body: "" }, [["a", COORD], ...tags], at);

/** A task of the project's for the helper, handed in and accepted at `acceptedAt`. */
function acceptedTask(relay: Relay, what: string, acceptedAt: number) {
  const made = record(
    ME,
    "Task",
    [
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", HELPER],
      ["task-helper", HELPER],
      ["task-what", what],
      ["task-done", "It works."],
      ["task-size", "small"],
    ],
    acceptedAt - 3 * DAY,
  );
  const step = (by: string, part: string, at: number, extra: string[][]) =>
    record(
      by,
      part,
      [
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", made.id],
        ["task", made.id],
        ...extra,
      ],
      at,
    );
  const proof = step(HELPER, "evidence", acceptedAt - DAY, [
    ["task-link", "https://example.org/proof"],
  ]);
  relay.seed(made);
  relay.seed(proof);
  relay.seed(
    step(ME, "confirm", acceptedAt, [
      ["e", proof.id],
      ["task-evidence", proof.id],
    ]),
  );
}

/** A project whose last two updates were `last` and `last + 7` days ago; the older one made two promises. */
function seed(relay: Relay, last: number) {
  for (const [key, name] of [
    [ME, "Mia Maker"],
    [HELPER, "Robin Helper"],
  ])
    relay.seed(
      event(0, key, { name, display_name: name }, [], now() - 90 * DAY),
    );
  relay.seed(projectRecord(ME, "rhythm", "Rhythm", now() - 60 * DAY));
  relay.seed(
    record(
      ME,
      "Two updates ago",
      [
        ["update-part", "next", "Ship sign-up\nWrite the guide"],
        ["promise", "0", "Ship sign-up"],
        ["promise", "1", "Write the guide"],
      ],
      now() - (last + 7) * DAY,
    ),
  );
  relay.seed(
    record(ME, "Last update", [["update-kind", "weekly"]], now() - last * DAY),
  );
}

const updates = (relay: Relay) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === ME &&
      e.tags.some((t) => t[0] === "update-part" && t[1] === "done"),
  );

test("a late update is said to everyone; the dialog starts from last week's promises and the work accepted since", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  // Accepted since the last update: two pieces. Accepted before it: one, which is not offered again.
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  acceptedTask(relay, "Translate the guide.", now() - 4 * DAY);
  acceptedTask(relay, "Old work from before.", now() - 12 * DAY);

  // A visitor reads how late the update is.
  await install(page, relay, null);
  await page.goto(PAGE);
  const card = page.getByTestId("project-update-card");
  await expect(card.getByTestId("update-due-words")).toHaveText(
    "Update late by 3 days",
  );

  // The founder reads it on Your projects too.
  await page.evaluate((key) => localStorage.setItem("e2e.key", key), ME_KEY);
  await page.goto("/portfolio");
  await expect(page.getByTestId("your-project-due").first()).toHaveText(
    "Update late by 3 days",
    { timeout: 30_000 },
  );

  await page.goto(PAGE);
  await card.getByRole("button", { name: "Post one" }).click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  // Last time's promises, one tap each.
  const promises = dialog.getByTestId("update-due-promise");
  await expect(promises).toHaveCount(2);
  await promises
    .filter({ hasText: "Ship sign-up" })
    .getByRole("radio", { name: "Done", exact: true })
    .check();
  await promises
    .filter({ hasText: "Write the guide" })
    .getByRole("radio", { name: "Not done" })
    .check();
  // The work accepted since, newest first; one is left out.
  const accepted = dialog.getByTestId("update-accepted-item");
  await expect(accepted).toHaveCount(2, { timeout: 30_000 });
  await expect(accepted.first()).toContainText("Translate the guide.");
  await expect(dialog).not.toContainText("Old work from before.");
  await dialog
    .getByRole("button", { name: "Leave out: Translate the guide." })
    .click();
  await expect(accepted).toHaveCount(1);
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByLabel("What happened this week").fill("We shipped.");
  // Four lines typed: only three become promises, and the dialog says so before publishing.
  await dialog.getByLabel("What's next").fill("One\nTwo\nThree\nFour");
  await expect(dialog.getByTestId("update-next-too-many")).toBeVisible();
  await expectAccessible(page, "the update dialog with last week's promises");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => updates(relay).length).toBe(1);
  const posted = updates(relay)[0];
  expect(posted.tags).toContainEqual([
    "update-part",
    "done",
    "Work accepted: Record the sign-up flow.\nWe shipped.",
  ]);
  expect(posted.tags.filter((t) => t[0] === "promise")).toEqual([
    ["promise", "0", "One"],
    ["promise", "1", "Two"],
    ["promise", "2", "Three"],
  ]);
  expect(
    posted.tags.filter((t) => t[0] === "promise-mark").map((t) => t[2]),
  ).toEqual(expect.arrayContaining(["done", "not-done"]));

  // The note after posting, and the record to share.
  const note = page.getByTestId("update-posted");
  await expect(note).toBeVisible();
  await expect(note.getByTestId("update-posted-streak")).toContainText(
    /week one|weeks in a row/,
  );
  await note.getByTestId("share-record").click();
  await expect(note.getByTestId("share-record-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Rhythm on Creaton");
  expect(copied).toContain("1 of 2 promises kept");
  expect(copied).toMatch(/https?:\/\/\S+rhythm\S*$/);
  expect(copied).not.toMatch(/earn|price|\$/i);
  await expectAccessible(page, "the project page after posting an update");
  await note.getByRole("button", { name: "Done" }).click();
  await expect(note).toHaveCount(0);
  // Posted today: nothing is late any more.
  await expect(card.getByTestId("update-due-words")).toHaveCount(0);
});

test("a run of weeks shows on Your projects and in the note; when copying fails the words are shown instead", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  // Updates seven and fourteen days ago: last week and the week before, whatever today is.
  seed(relay, 7);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
  });
  await install(page, relay, ME_KEY);
  await page.goto("/portfolio");
  await expect(page.getByTestId("your-project-streak").first()).toHaveText(
    "2 weeks in a row",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("your-project-due").first()).toHaveText(
    "Update due today",
  );

  await page.goto(PAGE);
  await page
    .getByTestId("project-update-card")
    .getByRole("button", { name: "Post one" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-accepted")).toHaveCount(0);
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByLabel("What happened this week").fill("Kept going.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  const note = page.getByTestId("update-posted");
  await expect(note.getByTestId("update-posted-streak")).toHaveText(
    "That's 3 weeks in a row. Keep it going next week.",
  );
  await note.getByTestId("share-record").click();
  await expect(note.getByTestId("share-record-words")).toHaveValue(
    /Rhythm on Creaton: 3 weeks in a row\. http/,
  );
  await expect(note.getByTestId("share-record-status")).toHaveText("");
});

test("at 390px the update dialog and the note after posting fit with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  await install(page, relay, ME_KEY);
  await page.goto(PAGE);
  await page
    .getByTestId("project-update-card")
    .getByRole("button", { name: "Post one" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-accepted-item")).toHaveCount(1, {
    timeout: 30_000,
  });
  const fits = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(await fits()).toBe(true);
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(page.getByTestId("update-posted")).toBeVisible();
  expect(await fits()).toBe(true);
});
