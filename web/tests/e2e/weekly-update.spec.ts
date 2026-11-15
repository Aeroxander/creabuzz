import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

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
 * The second and third weekly update, made easy: "Draft from the record" fills what happened, the help needed and one
 * line from the project's own record only (never what's next), the server's own words show when its AI limit is
 * reached, the founder's update day can be chosen or turned off, and after posting a weekly calendar file can be added.
 * Nothing here is sent by email or push.
 */

const ME_KEY = "d1".repeat(32);
const ME = pubkeyOf(ME_KEY);
const HELPER = pubkeyOf("d2".repeat(32));
const COORD = coordOf(ME, "loop");
const PAGE = projectPath(ME, "loop");
const LLM = "**/llm/chat/completions";

const record = (by: string, title: string, tags: string[][], at: number) =>
  event(47003, by, { title, body: "" }, [["a", COORD], ...tags], at);

/** A task for the helper, handed in and accepted at `acceptedAt`. */
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

/**
 * A project whose last update was `last` days ago, whose update before it made two promises and asked for help, and
 * that has one goal.
 */
function seed(relay: Relay, last: number) {
  for (const [key, name] of [
    [ME, "Mia Maker"],
    [HELPER, "Robin Helper"],
  ])
    relay.seed(
      event(0, key, { name, display_name: name }, [], now() - 90 * DAY),
    );
  relay.seed(projectRecord(ME, "loop", "Loop", now() - 60 * DAY));
  relay.seed(
    record(
      ME,
      "Two updates ago",
      [
        ["update-part", "next", "Ship sign-up\nWrite the guide"],
        ["promise", "0", "Ship sign-up"],
        ["promise", "1", "Write the guide"],
        ["help-needed", "Someone to test sign-up on an older phone."],
        ["help-size", "small"],
      ],
      now() - (last + 7) * DAY,
    ),
  );
  relay.seed(
    record(ME, "Last update", [["update-kind", "weekly"]], now() - last * DAY),
  );
  relay.seed(
    record(
      ME,
      "Goal",
      [
        ["goal", "g1"],
        ["goal-level", "primary"],
        ["goal-text", "A first version ten people use"],
        ["goal-how", "Ten people sign in in a week"],
        ["goal-state", "open"],
      ],
      now() - 50 * DAY,
    ),
  );
}

const weekly = (relay: Relay) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === ME &&
      e.tags.some((t) => t[0] === "update-part" && t[1] === "done"),
  );

/** What the AI stand-in is asked, and what it answers. */
function standIn(page: Page, reply: unknown) {
  const asked: { system: string; user: string }[] = [];
  return {
    asked,
    ready: page.route(LLM, (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        messages: { role: string; content: string }[];
      };
      asked.push({
        system: body.messages.find((m) => m.role === "system")?.content ?? "",
        user: body.messages.find((m) => m.role === "user")?.content ?? "",
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          choices: [
            {
              message: {
                content:
                  typeof reply === "string" ? reply : JSON.stringify(reply),
              },
            },
          ],
        }),
      });
    }),
  };
}

async function openDialog(page: Page) {
  await page.goto(PAGE);
  await page
    .getByTestId("project-update-card")
    .getByRole("button", { name: "Post one" })
    .click();
  return page.getByRole("dialog", { name: "Post update" });
}

test("'Draft from the record' fills what happened, the help and one line from the record only, never what's next; a made-up fact is left out", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  acceptedTask(relay, "Translate the guide.", now() - 4 * DAY);
  // Labels the AI is given, newest accepted work first: w1 Translate, w2 Record. Promises newest first: p1 Ship, p2 Write.
  const ai = standIn(page, {
    done: [
      { text: "The sign-up flow was recorded.", from: ["w2"] },
      { text: "The guide was translated.", from: ["w1"] },
      // A stand-in that invents a fact: a number the record does not hold.
      { text: "The guide reached 500 readers.", from: ["w1"] },
      // And one that cites nothing.
      { text: "We signed a partner.", from: [] },
    ],
    help: [
      {
        text: "We still need someone to test sign-up on an older phone.",
        from: ["h1"],
      },
    ],
    line: "Sign-up recorded and the guide translated.",
    // It tries to write the promises too. They must never reach the form.
    next: ["Launch in March"],
  });
  await ai.ready;
  await install(page, relay, ME_KEY);
  const dialog = await openDialog(page);

  // The founder marks last week's first promise before drafting: the AI is told the mark.
  await dialog
    .getByTestId("update-due-promise")
    .filter({ hasText: "Ship sign-up" })
    .getByRole("radio", { name: "Done", exact: true })
    .check();
  await expect(dialog.getByTestId("update-accepted-item")).toHaveCount(2, {
    timeout: 30_000,
  });
  await dialog.getByTestId("update-draft-button").click();
  await expect(dialog.getByTestId("update-draft-done")).toContainText(
    "Drafted from your record.",
  );
  await expect(dialog.getByTestId("update-draft-done")).toContainText(
    "2 lines were left out because your record doesn't back them.",
  );

  // Only the record went to the AI: its accepted work, promises with their marks, the goal and the open help.
  expect(ai.asked).toHaveLength(1);
  const { user, system } = ai.asked[0];
  expect(user).toContain("Work accepted: Translate the guide.");
  expect(user).toContain("Work accepted: Record the sign-up flow.");
  expect(user).toContain("(marked done): Ship sign-up");
  expect(user).toContain("(not answered yet): Write the guide");
  expect(user).toContain("A first version ten people use");
  expect(user).toContain("Someone to test sign-up on an older phone.");
  expect(system).toContain("Do not write what the project will do next");

  const done = dialog.getByLabel("What happened this week");
  await expect(done).toHaveValue(
    "The sign-up flow was recorded.\nThe guide was translated.",
  );
  await expect(dialog.getByLabel("Help needed (optional)")).toHaveValue(
    "We still need someone to test sign-up on an older phone.",
  );
  await expect(dialog.getByLabel("In one line (optional)")).toHaveValue(
    "Sign-up recorded and the guide translated.",
  );
  // What's next stays the founder's own words: nothing was put there.
  await expect(dialog.getByLabel("What's next")).toHaveValue("");
  // The accepted work is already said, so its lines are not added a second time.
  await expect(dialog.getByTestId("update-accepted-covered")).toBeVisible();
  await expectAccessible(page, "the update dialog after a draft");

  // The founder edits the line, writes the promises, and publishes: they sign every word.
  await dialog.getByLabel("Title").fill("Week three");
  await dialog
    .getByLabel("In one line (optional)")
    .fill("Sign-up recorded, guide translated.");
  await dialog.getByLabel("What's next").fill("Invite the first ten people");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => weekly(relay).length).toBe(1);
  const posted = weekly(relay)[0];
  expect(posted.tags).toEqual(
    expect.arrayContaining([
      [
        "update-part",
        "done",
        "The sign-up flow was recorded.\nThe guide was translated.",
      ],
      ["update-part", "next", "Invite the first ten people"],
      ["update-part", "line", "Sign-up recorded, guide translated."],
      ["promise", "0", "Invite the first ten people"],
    ]),
  );
  const text = JSON.stringify(posted);
  expect(text).not.toContain("500 readers");
  expect(text).not.toContain("partner");
  expect(text).not.toContain("Launch in March");
  expect(text).not.toContain("Work accepted:");
});

test("a draft never overwrites the founder's own words", async ({ page }) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  const ai = standIn(page, {
    done: [{ text: "The sign-up flow was recorded.", from: ["w1"] }],
    help: [],
    line: "Sign-up recorded.",
  });
  await ai.ready;
  await install(page, relay, ME_KEY);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("update-accepted-item")).toHaveCount(1, {
    timeout: 30_000,
  });
  const done = dialog.getByLabel("What happened this week");
  await done.fill("My own words about the week.");
  await dialog.getByTestId("update-draft-button").click();
  await expect(dialog.getByTestId("update-draft-done")).toContainText(
    'Your own words in "What happened this week" were left as they are.',
  );
  await expect(done).toHaveValue("My own words about the week.");
  // The line was empty, so it took the draft; the accepted work is still added as its own lines.
  await expect(dialog.getByLabel("In one line (optional)")).toHaveValue(
    "Sign-up recorded.",
  );
  await expect(dialog.getByTestId("update-accepted-covered")).toHaveCount(0);
});

test("when the AI limit is reached the server's own words are shown as they are, and the form still works", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  const words =
    "You have used all of today's AI help for your account. It comes back at midnight UTC, in about 5 hours. You can write this yourself in the meantime.";
  await page.route(LLM, (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: words,
        code: "ai_limit_account",
        retry_after_secs: 18_000,
      }),
    }),
  );
  await install(page, relay, ME_KEY);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("update-accepted-item")).toHaveCount(1, {
    timeout: 30_000,
  });
  await dialog.getByTestId("update-draft-button").click();
  await expect(dialog.getByTestId("update-draft-error")).toHaveText(words);
  await expect(dialog.getByLabel("What happened this week")).toHaveValue("");
  // Writing it yourself is still there, and the button can be pressed again.
  await expect(dialog.getByTestId("update-draft-button")).toBeEnabled();
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByLabel("What happened this week").fill("Wrote it myself.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect.poll(() => weekly(relay).length).toBe(1);
});

test("a reply that is not the record's, or a limit with no sentence of its own, says so in plain words", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  let answer: "invented" | "bare-429" = "invented";
  await page.route(LLM, (route) =>
    answer === "invented"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    done: [{ text: "We raised 2 million.", from: ["w1"] }],
                  }),
                },
              },
            ],
          }),
        })
      : route.fulfill({ status: 429, contentType: "text/plain", body: "slow" }),
  );
  await install(page, relay, ME_KEY);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("update-accepted-item")).toHaveCount(1, {
    timeout: 30_000,
  });
  await dialog.getByTestId("update-draft-button").click();
  await expect(dialog.getByTestId("update-draft-error")).toContainText(
    "The draft didn't match your record, so nothing was added.",
  );
  await expect(dialog.getByLabel("What happened this week")).toHaveValue("");
  answer = "bare-429";
  await dialog.getByTestId("update-draft-button").click();
  await expect(dialog.getByTestId("update-draft-error")).toHaveText(
    "The AI service is busy or your allowance is used up. Try again later, or write it yourself.",
  );
});

test("the update day: due words are neutral, the day can be changed, and one choice turns the reminder off for good", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  // Last update two days ago: not a week yet, so only the founder's update day can make it due.
  seed(relay, 2);
  await install(page, relay, ME_KEY);
  await page.goto(PAGE);
  const card = page.getByTestId("project-update-card");
  const select = card.getByTestId("update-day-select");
  await expect(select).toBeVisible({ timeout: 30_000 });

  // An update day that came round yesterday, with the last update before it: due, in neutral words.
  const names = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const yesterday = await page.evaluate(() =>
    new Date(Date.now() - 86_400_000).getDay(),
  );
  await select.selectOption({ label: names[yesterday] });
  const nudge = card.getByTestId("update-nudge");
  await expect(nudge).toContainText(
    `Your weekly update is due. ${names[yesterday]} is your update day.`,
  );
  await expect(nudge).not.toContainText(/haven't|have not|late|missed/i);
  await expectAccessible(page, "the update card with the update day");

  // An update day that comes round tomorrow: not due yet.
  const tomorrow = await page.evaluate(() =>
    new Date(Date.now() + 86_400_000).getDay(),
  );
  await select.selectOption({ label: names[tomorrow] });
  await expect(nudge).toHaveCount(0);

  // Turned off: no reminder, even when the day has come round; it stays off after a reload.
  await select.selectOption({ label: names[yesterday] });
  await expect(nudge).toBeVisible();
  await select.selectOption({ label: "No reminder" });
  await expect(nudge).toHaveCount(0);
  await page.reload();
  await expect(card.getByTestId("update-day-select")).toHaveValue("off");
  await expect(card.getByTestId("update-nudge")).toHaveCount(0);
});

test("after posting, 'Add a weekly reminder' gives a weekly calendar file for the update day, and promises no email or push", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  await install(page, relay, ME_KEY);
  const dialog = await openDialog(page);
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByLabel("What happened this week").fill("Kept going.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  const note = page.getByTestId("update-posted");
  await expect(note).toBeVisible();
  const weekday = await page.evaluate(() =>
    new Date((Date.now() / 1000 - 60 * 86_400) * 1000).getDay(),
  );
  const names = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  await expect(note.getByTestId("update-posted-reminder-note")).toHaveText(
    `A repeating event for your calendar app, every ${names[weekday]}. Nothing is sent from here.`,
  );
  await expect(note).not.toContainText(/e-?mail|push|notification/i);
  await expectAccessible(page, "the note after posting, with the reminder");

  const download = page.waitForEvent("download");
  await note.getByRole("button", { name: "Add a weekly reminder" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("weekly-update-loop.ics");
  const path = await file.path();
  const raw = await readFile(path, "utf8");
  // Long lines are folded in the file (a CRLF and a space); a calendar app joins them back.
  const text = raw.replace(/\r\n /g, "");
  const code = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday];
  expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(text).toContain(`RRULE:FREQ=WEEKLY;BYDAY=${code}\r\n`);
  expect(text).toContain("SUMMARY:Weekly update due: Loop\r\n");
  expect(text).toMatch(
    new RegExp(
      `URL:http://127\\.0\\.0\\.1:\\d+/launchpad/loop\\?author=${ME}&action=update\\r\\n`,
    ),
  );
  expect(raw).not.toMatch(/(?<!\r)\n/);
});

test("at 390px the update dialog with its draft button and the note with its reminder fit with no sideways scroll", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seed(relay, 10);
  acceptedTask(relay, "Record the sign-up flow.", now() - 5 * DAY);
  await install(page, relay, ME_KEY);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("update-draft-button")).toBeVisible();
  const fits = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(await fits()).toBe(true);
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(page.getByTestId("update-posted-reminder")).toBeVisible();
  expect(await fits()).toBe(true);
});
