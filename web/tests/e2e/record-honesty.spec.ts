import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  openAs,
  projectPath,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * A project's record tells the truth about who checked the work. Work only the founder checked is "Done, checked by the
 * founder" (to the founder, "checked by you"), counted apart from work someone else accepted and never called
 * accepted; how work counts is one note away, and opens from the keyboard; "Done means" is not said twice; a promise
 * that was never answered is "Not answered", never "Kept"; each share picture states only its own fact; and a profile
 * opens on the record only when there is one to read.
 */

const FOUNDER_KEY = "f1".repeat(32);
const MATE_KEY = "f2".repeat(32);
const HELPER_KEY = "f3".repeat(32);
const VISITOR_KEY = "f4".repeat(32);
const NEW_KEY = "f5".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const MATE = pubkeyOf(MATE_KEY);
const HELPER = pubkeyOf(HELPER_KEY);
const NEWBIE = pubkeyOf(NEW_KEY);
const SOLO_COORD = coordOf(FOUNDER, "lantern");
const TEAM_COORD = coordOf(FOUNDER, "beacon");
const SOLO = projectPath(FOUNDER, "lantern");
const SOLO_CARD = `/p/lantern-${FOUNDER.slice(0, 16)}`;
const TEAM_CARD = `/p/beacon-${FOUNDER.slice(0, 16)}`;
const WORK = "Write the first page";

function people(relay: Relay) {
  for (const [key, name] of [
    [FOUNDER, "Fay Founder"],
    [MATE, "Sol Mate"],
    [HELPER, "Robin Helper"],
  ])
    relay.seed(
      event(0, key, { name, display_name: name }, [], now() - 90 * DAY),
    );
}

/** A task as the app writes it, handed in by `helper` and confirmed by `checker`; returns nothing the test needs. */
function finishedTask(
  relay: Relay,
  coord: string,
  { helper, checker, what }: { helper: string; checker: string; what: string },
) {
  const task = event(
    47003,
    FOUNDER,
    { title: "Task", body: what },
    [
      ["a", coord],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", helper],
      ["task-helper", helper],
      ["task-what", what],
      // The solo box writes the same line twice; another task says something of its own.
      ["task-done", helper === FOUNDER ? what : "A page anyone can open."],
      ["task-size", "small"],
    ],
    now() - 3 * DAY,
  );
  relay.seed(task);
  const step = (
    by: string,
    part: string,
    extra: string[][],
    note: string,
    at: number,
  ) => {
    const record = event(
      47003,
      by,
      { title: part, body: note, ...(note ? { note } : {}) },
      [
        ["a", coord],
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", task.id],
        ["task", task.id],
        ["p", helper === by ? FOUNDER : helper],
        ...extra,
      ],
      at,
    );
    relay.seed(record);
    return record;
  };
  const work = step(helper, "evidence", [], what, now() - 2 * DAY);
  step(checker, "confirm", [["task-evidence", work.id]], "", now() - DAY);
}

/** A project of one: the founder alone, who finished one piece of work and checked it. */
function seedSolo(relay: Relay) {
  people(relay);
  relay.seed(projectRecord(FOUNDER, "lantern", "Lantern", now() - 20 * DAY));
  finishedTask(relay, SOLO_COORD, {
    helper: FOUNDER,
    checker: FOUNDER,
    what: WORK,
  });
}

/** A project with a teammate: one piece accepted by the teammate, one the founder did and checked alone. */
function seedMixed(relay: Relay) {
  people(relay);
  relay.seed(
    projectRecord(FOUNDER, "beacon", "Beacon", now() - 20 * DAY, {
      tags: [
        ["team", FOUNDER, "Founder"],
        ["team", MATE, "Reviewer"],
      ],
    }),
  );
  finishedTask(relay, TEAM_COORD, {
    helper: HELPER,
    checker: MATE,
    what: "Translate the guide",
  });
  finishedTask(relay, TEAM_COORD, {
    helper: FOUNDER,
    checker: FOUNDER,
    what: "Fix the typos",
  });
}

const blockClipboard = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
  });

test("one piece of work the founder checked alone is done, checked by the founder, apart from accepted work", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedSolo(relay);
  await blockClipboard(page);
  await install(page, relay, VISITOR_KEY);
  await page.goto(SOLO_CARD);
  const card = page.getByTestId("scorecard");
  // The record line says it in its own chip, and says nothing about accepted work.
  await expect(card.getByTestId("record-line-done-alone")).toHaveText(
    "1 piece of work done, checked by the founder",
    { timeout: 30_000 },
  );
  await expect(card.getByTestId("record-line-accepted")).toHaveCount(0);
  const done = card.getByTestId("scorecard-work-alone");
  await expect(done).toContainText(WORK);
  await expect(done).toContainText("Done, checked by the founder");
  await expect(done.getByTestId("checked-by")).toHaveText(
    "Done by Fay Founder · Checked by Fay Founder",
  );
  // The word "accepted" is for work someone else checked: nowhere on this page, the share buttons included.
  await expect(card).not.toContainText(/accepted/i);
  await expect(card).not.toContainText(/\$|price|earn|return/i);
  await expect(card.getByTestId("scorecard-share-done")).toHaveCount(0);
  // Share: the sentence states the founder's own check in its own words.
  await card.getByTestId("share-record").click();
  await expect(card.getByTestId("share-record-words")).toHaveValue(
    /^Lantern on Creaton: 1 piece of work done, checked by the founder\. http/,
  );
});

test("on the project page the founder reads 'checked by you', counted apart, with how work counts one key press away", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedSolo(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(SOLO);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-work-alone-totals")).toHaveText(
    "1 piece of work done, checked by you",
    { timeout: 30_000 },
  );
  await expect(record.getByTestId("record-work-totals")).toHaveCount(0);
  const line = record.getByTestId("record-work-alone");
  await expect(line).toContainText("Done, checked by you");
  await expect(line.getByTestId("checked-by")).toHaveText(
    "Done by you · Checked by you",
  );
  await expect(record.getByTestId("record-work-accepted")).toHaveCount(0);
  // "Done means" is the same line as the work, so it is not said a second time.
  await expect(line).not.toContainText("Done means");
  await expect(
    page.getByTestId("project-tasks").getByTestId("task-done-means"),
  ).toHaveCount(0);
  // The old explanation is a note, closed until asked, and it opens from the keyboard.
  const how = record.getByTestId("record-how-work-counts");
  await expect(how).toHaveAttribute("aria-expanded", "false");
  await how.focus();
  await page.keyboard.press("Enter");
  await expect(how).toHaveAttribute("aria-expanded", "true");
  const text = record.getByTestId("record-how-work-counts-text");
  await expect(text).toBeVisible();
  await expect(text).toContainText("counted apart");
  await expect(text).toContainText("other than the person who did it");
});

test("a promise still waiting has Do it now for a founder alone, which opens the box with the promise filled in", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  people(relay);
  relay.seed(projectRecord(FOUNDER, "lantern", "Lantern", now() - 20 * DAY));
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Week one", body: "" },
      [
        ["a", SOLO_COORD],
        ["update-part", "next", "Publish the first page"],
        ["promise", "0", "Publish the first page"],
      ],
      now() - DAY,
    ),
  );
  await install(page, relay, FOUNDER_KEY);
  await page.goto(SOLO);
  const doIt = page.getByTestId("record-do-it-now");
  await expect(doIt).toHaveAccessibleName("Do it now: Publish the first page", {
    timeout: 30_000,
  });
  // Reached and pressed from the keyboard.
  await doIt.focus();
  await page.keyboard.press("Enter");
  const box = page.getByRole("dialog", { name: "What did you get done?" });
  await expect(box.getByLabel("What did you finish?")).toHaveValue(
    "Publish the first page",
  );
  // Nothing was marked: no record was written by opening the box.
  expect(
    relay.events.filter((e) => e.tags.some((t) => t[0] === "promise-mark")),
  ).toHaveLength(0);

  // A visitor is not offered it: only a founder alone can do the work.
  await page.keyboard.press("Escape");
  await openAs(page, VISITOR_KEY, SOLO);
  await expect(page.getByTestId("record-lines")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("record-do-it-now")).toHaveCount(0);
});

test("an empty record tells the founder what to do alone, and the button opens the box", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  people(relay);
  relay.seed(projectRecord(FOUNDER, "lantern", "Lantern", now() - DAY));
  // The card is on the page only once the founder has something in it. One removed update record is something that
  // is not a line of the record: the card shows, and its list is empty.
  relay.seed(
    event(
      5,
      FOUNDER,
      "",
      [
        ["e", "ab".repeat(32)],
        ["k", "47003"],
      ],
      now() - 3600,
    ),
  );
  await install(page, relay, FOUNDER_KEY);
  await page.goto(SOLO);
  const empty = page.getByTestId("record-empty");
  await expect(empty).toContainText("Nothing on your record yet.", {
    timeout: 30_000,
  });
  await expect(empty).toContainText("Finish one thing and it shows here.");
  await empty.getByRole("button", { name: "Add what you did" }).click();
  await expect(
    page.getByRole("dialog", { name: "What did you get done?" }),
  ).toBeVisible();
});

test("work accepted by a teammate and work the founder checked alone are two numbers, two pictures, two sentences", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedMixed(relay);
  await blockClipboard(page);
  await install(page, relay, VISITOR_KEY);
  await page.goto(TEAM_CARD);
  const card = page.getByTestId("scorecard");
  await expect(card.getByTestId("record-line-accepted")).toHaveText(
    "1 piece of work accepted by others",
    { timeout: 30_000 },
  );
  await expect(card.getByTestId("record-line-done-alone")).toHaveText(
    "1 piece of work done, checked by the founder",
  );
  // The two kinds of work are listed under their own words.
  await expect(card.getByTestId("scorecard-work-item")).toContainText(
    "Work accepted",
  );
  await expect(card.getByTestId("scorecard-work-item")).toContainText(
    "Checked by Sol Mate",
  );
  await expect(card.getByTestId("scorecard-work-alone")).toContainText(
    "Done, checked by the founder",
  );
  await expect(card.getByTestId("scorecard-work-alone")).not.toContainText(
    /accepted/i,
  );

  // Each picture says only its own fact, so no two downloads are the same image.
  const hashes: string[] = [];
  for (const [kind, sentence] of [
    ["accepted", /1 piece of work accepted\. http/],
    ["done", /1 piece of work done, checked by the founder\. http/],
  ] as const) {
    await card.getByTestId(`scorecard-share-${kind}`).click();
    await card.getByTestId("share-record").click();
    await expect(card.getByTestId("share-record-words")).toHaveValue(sentence);
    const download = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download image" }).click();
    const file = await (await download).path();
    hashes.push(createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  expect(new Set(hashes).size).toBe(2);
  testInfo.annotations.push({
    type: "picture hashes",
    description: hashes.join(" "),
  });
});

test("a promise the update did not answer is Not answered, and the answers it gave are Kept and Missed", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  people(relay);
  relay.seed(projectRecord(FOUNDER, "lantern", "Lantern", now() - 20 * DAY));
  const first = event(
    47003,
    FOUNDER,
    { title: "Week one", body: "" },
    [
      ["a", SOLO_COORD],
      [
        "update-part",
        "next",
        "Publish the page\nAsk three people\nFix the typos",
      ],
      ["promise", "0", "Publish the page"],
      ["promise", "1", "Ask three people"],
      ["promise", "2", "Fix the typos"],
    ],
    now() - 8 * DAY,
  );
  relay.seed(first);
  relay.seed(
    event(
      47003,
      FOUNDER,
      {
        title: "Week two",
        body: "What we said last time\nDone: Publish the page\nNot done: Ask three people (ran out of time)\n\nWhat happened this week\nShipped.",
      },
      [
        ["a", SOLO_COORD],
        ["update-part", "done", "Shipped."],
        ["promise-mark", `${first.id}:0`, "done", ""],
        ["promise-mark", `${first.id}:1`, "not-done", "ran out of time"],
      ],
      now() - 2 * DAY,
    ),
  );
  await install(page, relay, VISITOR_KEY);
  await page.goto(SOLO_CARD);
  const rows = page
    .getByTestId("scorecard-update")
    .getByTestId("update-promise-row");
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.nth(0)).toContainText("Kept");
  await expect(rows.nth(0)).toContainText("Publish the page");
  await expect(rows.nth(1)).toContainText("Missed");
  await expect(rows.nth(1)).toContainText("ran out of time");
  await expect(rows.nth(2)).toContainText("Not answered");
  await expect(rows.nth(2)).toContainText("Fix the typos");
  await expect(rows.nth(2)).not.toContainText("Kept");
  await expect(page.getByTestId("update-this-week")).toContainText("Shipped.");
});

test("a profile opens on Record once there is a record to read, and on Posts when there is none", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedSolo(relay);
  relay.seed(event(0, NEWBIE, { name: "Nia Newcomer" }, [], now() - 90 * DAY));
  await install(page, relay, VISITOR_KEY);
  await page.goto(`/u/${FOUNDER}`);
  await expect(page.getByRole("tab", { name: "Record" })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 30_000 },
  );
  // The line counts the founder's own check on its own, never as accepted.
  const track = page.getByTestId("track-record");
  await expect(track.getByTestId("track-record-alone")).toHaveText(
    "1 piece of work done, checked by the founder",
  );
  await expect(track.getByTestId("track-record-accepted")).toHaveText(
    "0 pieces of work accepted",
  );
  // A tab named in the address wins.
  await page.goto("/discover");
  await page.goto(`/u/${FOUNDER}#posts`);
  await expect(page.getByRole("tab", { name: "Posts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Someone with nothing to read opens on Posts, with a plain empty state.
  await page.goto(`/u/${NEWBIE}`);
  await expect(page.getByRole("tab", { name: "Posts" })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("profile-posts-list")).toContainText(
    "Nothing posted yet.",
  );
});
