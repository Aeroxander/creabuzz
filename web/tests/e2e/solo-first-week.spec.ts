import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
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
 * A person alone on a new project: the page's first screen is the header, one live line and one first-week card with
 * one green button; "Add what you did" is two presses and one typed line from "Done" (the task is made, the line
 * is handed in and the founder checks it, once each); a try that stops part of the way says so and a retry makes no
 * second record; nobody else sees the solo box; and what was put away (chat, the listing choice) is one keyboard
 * press from the page.
 */

const FOUNDER_KEY = "c1".repeat(32);
const VISITOR_KEY = "c2".repeat(32);
const MATE_KEY = "c3".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const VISITOR = pubkeyOf(VISITOR_KEY);
const MATE = pubkeyOf(MATE_KEY);
const COORD = coordOf(FOUNDER, "nebula");
const PROJECT = projectPath(FOUNDER, "nebula");
const STARTED = `${PROJECT}&started=1`;

function seedNew(relay: Relay, tags: string[][] = [], startedAgo = 60) {
  for (const [key, who] of [
    [FOUNDER, "Fay Founder"],
    [VISITOR, "Robin Owner"],
    [MATE, "Sol Mate"],
  ])
    relay.seed(
      event(0, key, { name: who, display_name: who }, [], now() - 90 * DAY),
    );
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - startedAgo, { tags }),
  );
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Goal", body: "A first version ten people use" },
      [
        ["a", COORD],
        ["goal", "g1"],
        ["goal-level", "primary"],
        ["goal-text", "A first version ten people use"],
        ["goal-how", "Ten people sign in in a week"],
        ["goal-state", "open"],
      ],
      now() - startedAgo + 1,
    ),
  );
}

/** The records of one step of a task the app has sent. */
const steps = (relay: Relay, part: string) =>
  relay.events.filter(
    (e) =>
      e.pubkey === FOUNDER &&
      e.tags.some((t) => t[0] === "task-part" && t[1] === part),
  );

const green = (page: Page, scope: string) =>
  page.locator(`:is(${scope}) button.bg-primary:visible`);

const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "390x844", width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
  test(`first screen at ${viewport.name}: the header, one live line and one first-week card with one green button`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const relay = createMockRelay();
    seedNew(relay);
    await install(page, relay, FOUNDER_KEY);
    // Right after Start the recovery key is not saved yet: its line is on the card, which is what is measured.
    await page.addInitScript(() =>
      localStorage.removeItem("buzz.identity.backedUp"),
    );
    await page.goto(STARTED);
    const card = page.getByTestId("first-week");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("recovery-key-prompt")).toBeVisible();
    await expect(page.getByTestId("started-card")).toBeVisible();
    await expect(page.getByTestId("first-week-add")).toBeVisible();
    // One filled green button in the header, the live line and the card together, and it is the next step.
    await expect(
      green(
        page,
        '[data-testid="launch-hero"], [data-testid="started-card"], [data-testid="first-week"]',
      ),
    ).toHaveCount(1);
    await expect(
      page.getByTestId("first-week").locator("button.bg-primary"),
    ).toHaveText("Add what you did");
    // The card, with its green button, is on the first screen.
    const add = await page.getByTestId("first-week-add").boundingBox();
    expect((add?.y ?? 9999) + (add?.height ?? 0)).toBeLessThanOrEqual(
      viewport.height,
    );
    // Chat, Announce and the listing choice are not on the page until "More to set up" is opened.
    for (const id of [
      "launch-chat",
      "project-listing",
      "project-listing-toggle",
    ])
      await expect(page.getByTestId(id)).toHaveCount(0);
    // The card says little: under 120 words on the first screen, header and card together.
    const words = await page.evaluate((height) => {
      const parts = document.querySelectorAll(
        '[data-testid="launch-hero"], [data-testid="started-card"], [data-testid="first-week"]',
      );
      let count = 0;
      for (const part of parts) {
        const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim() ?? "";
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          if (text && box.width > 0 && box.top < height)
            count += text.split(/\s+/).length;
        }
      }
      return count;
    }, viewport.height);
    console.log(`first-screen words at ${viewport.name}: ${words}`);
    expect(words).toBeLessThan(120);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expectAccessible(page, `the first screen at ${viewport.name}`);
  });
}

test("Add what you did is two presses and one typed line from Done: one task, one hand-in, one check", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-add").click();
  const dialog = page.getByRole("dialog", { name: "What did you get done?" });
  await expect(dialog).toBeVisible();
  // Read in this order: the title, the field, the link, then the buttons.
  const order = await dialog.evaluate((box) =>
    [...box.querySelectorAll("h2, textarea, input, button")].map(
      (el) =>
        `${el.tagName.toLowerCase()}:${(el as HTMLElement).dataset.testid ?? ""}`,
    ),
  );
  expect(order).toEqual([
    "h2:",
    "textarea:solo-win-what",
    "input:solo-win-link",
    "button:solo-win-how-counts",
    "button:solo-win-cancel",
    "button:solo-win-submit",
  ]);
  await expect(dialog).toContainText(
    "You are the only person here, so you check it yourself.",
  );
  await expect(dialog.getByRole("button", { name: "Done" })).toHaveClass(
    /bg-primary/,
  );
  // "How work counts" opens from the keyboard.
  const how = dialog.getByTestId("solo-win-how-counts");
  await how.focus();
  await page.keyboard.press("Enter");
  await expect(how).toHaveAttribute("aria-expanded", "true");
  await expect(dialog).toContainText(
    "A founder with nobody else on the team can check their own work",
  );
  await dialog.getByLabel("What did you finish?").fill("Wrote the first page");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => steps(relay, "confirm").length).toBe(1);
  expect(steps(relay, "task")).toHaveLength(1);
  expect(steps(relay, "evidence")).toHaveLength(1);

  // The card moves on: 2 of 3, the work is done, and the green button is now the update.
  const card = page.getByTestId("first-week");
  await expect(card.getByTestId("first-week-count")).toHaveText("2 of 3");
  await expect(card.getByTestId("first-week-work-done")).toHaveText(
    "First piece of work done.",
  );
  await expect(card.locator("button.bg-primary")).toHaveText(
    "Post this week's update",
  );
  await expect(card.getByTestId("first-week-add")).toHaveCount(0);
});

test("a hand-in the server refuses once says part was saved; Try again ends in one task, one hand-in and one check", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (e) =>
      refuse && e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence")
        ? "blocked: try later"
        : null,
  });
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-add").click();
  const dialog = page.getByRole("dialog", { name: "What did you get done?" });
  await dialog.getByLabel("What did you finish?").fill("Wrote the first page");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog.getByTestId("solo-win-failed")).toHaveText(
    "Saved part of this. Try again.",
  );
  expect(steps(relay, "task")).toHaveLength(1);
  expect(steps(relay, "evidence")).toHaveLength(0);
  expect(steps(relay, "confirm")).toHaveLength(0);
  // The words stay, and a half-done task is not shown as done.
  await expect(dialog.getByLabel("What did you finish?")).toHaveValue(
    "Wrote the first page",
  );
  await expect(page.getByTestId("first-week-work-done")).toHaveCount(0);
  refuse = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => steps(relay, "confirm").length).toBe(1);
  expect(steps(relay, "task")).toHaveLength(1);
  expect(steps(relay, "evidence")).toHaveLength(1);
  await expect(page.getByTestId("first-week-work-done")).toBeVisible();
});

test("a try that stopped survives a reload: the card says part was saved, and Try again finishes it once", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (e) =>
      refuse && e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence")
        ? "blocked: try later"
        : null,
  });
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-add").click();
  const dialog = page.getByRole("dialog", { name: "What did you get done?" });
  await dialog.getByLabel("What did you finish?").fill("Wrote the first page");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog.getByTestId("solo-win-failed")).toBeVisible();
  refuse = false;
  await page.reload();
  const card = page.getByTestId("first-week");
  await expect(card.getByTestId("first-week-part-saved")).toHaveText(
    "Saved part of this. Try again.",
    { timeout: 20_000 },
  );
  await card.getByTestId("first-week-retry").click();
  const again = page.getByRole("dialog", { name: "What did you get done?" });
  await expect(again.getByLabel("What did you finish?")).toHaveValue(
    "Wrote the first page",
  );
  await again.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => steps(relay, "confirm").length).toBe(1);
  expect(steps(relay, "task")).toHaveLength(1);
  expect(steps(relay, "evidence")).toHaveLength(1);
});

test("Add something to do makes the task only; I did it on the card and on the row finish it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-plan").click();
  const dialog = page.getByRole("dialog", { name: "Add something to do" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("What do you want to do?").fill("Write the page");
  // "What finished looks like" is closed until it is asked for, with the line that it cannot be changed.
  const toggle = dialog.getByTestId("solo-win-finish-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(dialog.getByTestId("solo-win-done-means")).toBeVisible();
  await expect(dialog).toContainText("You can't change this after you add it");
  await dialog.getByRole("button", { name: "Add it" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => steps(relay, "task").length).toBe(1);
  expect(steps(relay, "evidence")).toHaveLength(0);
  // With no words of its own, "Done means" is the same line.
  expect(steps(relay, "task")[0].tags).toContainEqual([
    "task-done",
    "Write the page",
  ]);

  // The card now says what was promised, with one green "I did it"; the row has the same one button, no hand-in.
  const card = page.getByTestId("first-week");
  await expect(card.getByTestId("first-week-said")).toHaveText(
    "You said you would: Write the page.",
  );
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row.getByTestId("task-did-it")).toBeVisible();
  await expect(row.getByRole("button", { name: /Hand in/ })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Mark as done/ })).toHaveCount(
    0,
  );
  await expect(row.getByTestId("task-who")).toContainText("With you");
  // From the keyboard: Enter on the row's button opens the box with the task's words.
  await row.getByTestId("task-did-it").focus();
  await page.keyboard.press("Enter");
  const finish = page.getByRole("dialog", { name: "What did you get done?" });
  await expect(finish.getByLabel("What did you finish?")).toHaveValue(
    "Write the page",
  );
  await page.keyboard.press("Escape");
  await expect(finish).toHaveCount(0);
  await row.getByTestId("task-did-it").click();
  await page
    .getByRole("dialog", { name: "What did you get done?" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect.poll(() => steps(relay, "confirm").length).toBe(1);
  // Still the one task: the hand-in and the check belong to it.
  expect(steps(relay, "task")).toHaveLength(1);
  expect(steps(relay, "evidence")).toHaveLength(1);
  await expect(page.getByTestId("first-week-work-done")).toBeVisible();
});

test("a founder with someone else on the project is not offered the solo box, and the card says where tasks are made", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [
    ["team", MATE, "member"],
    ["team-invite", MATE, "inv1"],
    ["p", MATE],
  ]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const card = page.getByTestId("first-week");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Make a task in the Tasks card below.");
  for (const id of ["first-week-add", "first-week-plan", "add-task-solo"])
    await expect(page.getByTestId(id)).toHaveCount(0);
  // The full form is still there.
  await expect(page.getByTestId("give-task")).toBeVisible();
});

test("a visitor sees Follow as the one green button; the founder and the team see no Follow and no solo box", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [
    ["team", MATE, "member"],
    ["team-invite", MATE, "inv1"],
    ["p", MATE],
  ]);
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  // A project made from Start has no sale yet: its Follow is the supporters button.
  const follow = page.getByTestId("launch-back-idea");
  await expect(follow).toBeVisible({ timeout: 20_000 });
  await expect(follow).toHaveClass(/bg-primary/);
  await expect(
    page.locator('[data-testid="launch-hero"] button.bg-primary'),
  ).toHaveCount(1);
  await expect(page.getByTestId("first-week")).toHaveCount(0);
  await expect(page.getByTestId("add-task-solo")).toHaveCount(0);
  for (const key of [FOUNDER_KEY, MATE_KEY]) {
    await openAs(page, key, PROJECT);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Nebula",
    );
    await expect(page.getByTestId("launch-back-idea")).toHaveCount(0);
    await expect(page.getByTestId("launch-follow")).toHaveCount(0);
    await expect(page.getByTestId("launch-follow-note")).toHaveCount(0);
  }
});

test("More to set up holds the chat, the announcement and the listing choice, closed, and the keyboard opens it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("first-week")).toBeVisible({
    timeout: 20_000,
  });
  const toggle = page.getByTestId("more-to-set-up-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("project-listing")).toHaveCount(0);
  for (let i = 0; i < 80; i++) {
    if (await toggle.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("project-listing")).toBeVisible();
  await expect(page.getByTestId("project-listing-toggle")).toBeVisible();
  // The chat card is the founder's to set up: it offers the rooms the project does not have yet.
  await expect(page.getByTestId("launch-chat")).toBeVisible();
});
