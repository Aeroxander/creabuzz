import { readFile } from "node:fs/promises";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
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
 * A new founder's first week on the project page: one welcome card they can put away (`?started=1`), one "First week"
 * list with the next step, and no wall of empty cards. Tasks, Team and Record appear once they hold something, or when
 * the founder presses "Set up more". Also: the weekly reminder opens the update form, the recovery key is asked for on
 * the first page, a line says who answers for agents, and an AI project's founder gets the commands for an agent.
 */

const FOUNDER_KEY = "b1".repeat(32);
const VISITOR_KEY = "b2".repeat(32);
const AGENT_KEY = "b3".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const VISITOR = pubkeyOf(VISITOR_KEY);
const AGENT = pubkeyOf(AGENT_KEY);
const COORD = coordOf(FOUNDER, "nebula");
const PROJECT = projectPath(FOUNDER, "nebula");
const STARTED = `${PROJECT}&started=1`;

const founderUpdates = (relay: Relay) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === FOUNDER &&
      e.tags.some((t) => t[0] === "update-part"),
  );

/** A brand-new project: no updates, one goal, the people read as names. */
function seedNew(
  relay: Relay,
  tags: string[][] = [],
  startedAgo = 60,
  name = "Nebula",
) {
  for (const [key, who] of [
    [FOUNDER, "Fay Founder"],
    [VISITOR, "Robin Owner"],
  ])
    relay.seed(
      event(0, key, { name: who, display_name: who }, [], now() - 90 * DAY),
    );
  relay.seed(
    projectRecord(FOUNDER, "nebula", name, now() - startedAgo, { tags }),
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

/**
 * The key this account backed up is not remembered. By default on every load; with `firstLoadOnly` only at the first
 * load of the tab, so what the page saves afterwards (a copied key) is still there after a reload.
 */
async function notBackedUp(page: Page, firstLoadOnly = false) {
  await page.addInitScript((once) => {
    if (once) {
      if (sessionStorage.getItem("e2e.cleared")) return;
      sessionStorage.setItem("e2e.cleared", "1");
    }
    localStorage.removeItem("buzz.identity.backedUp");
  }, firstLoadOnly);
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("a founder lands on the live project with one live line and one first-week card, and no empty cards", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(STARTED);

  // One line: the project is live, its short link, and Copy.
  const live = page.getByTestId("started-card");
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect(live).toContainText("Your project is live:");
  await expect(live.getByTestId("started-link-short")).toContainText(
    `/p/nebula-${FOUNDER.slice(0, 16)}`,
  );
  const link = `http://127.0.0.1:${new URL(page.url()).port}/p/nebula-${FOUNDER.slice(0, 16)}`;
  await live.getByTestId("started-copy").click();
  await expect(live.getByTestId("started-copy-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // The first-week card: its heading, one line, "1 of 3", the goal ticked and nothing else asking for the first update.
  const week = page.getByTestId("first-week");
  await expect(week.getByRole("heading")).toHaveText("Your first week");
  await expect(week.getByTestId("first-week-due")).toHaveText(
    "Three steps. You can do all of them on your own.",
  );
  await expect(week.getByTestId("first-week-count")).toHaveText("1 of 3");
  await expect(week.locator("li[data-done=true]")).toHaveCount(1);
  await expect(
    week.locator("li", { hasText: "Say your goal" }),
  ).toHaveAttribute("data-done", "true");
  await expect(week.getByTestId("first-week-goal")).toHaveText(
    "A first version ten people use",
  );
  await expect(page.getByTestId("project-update-card")).toHaveCount(0);
  await expect(page.getByTestId("update-nudge")).toHaveCount(0);

  // Tasks and Team are on the page from the start; Record waits for something to hold. Nothing asks to "set up more".
  await expect(page.getByTestId("project-tasks")).toBeVisible();
  await expect(page.getByTestId("project-team")).toBeVisible();
  await expect(page.getByTestId("project-record")).toHaveCount(0);
  await expect(page.getByTestId("set-up-more")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "the project page in its first week");
});

test("Share is one control: copy the link, download the picture, add a weekly reminder", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("first-week")).toBeVisible({
    timeout: 20_000,
  });
  // The four separate buttons it replaces are gone from the page.
  for (const gone of ["Share it", "Download image", "Copy an invite"])
    await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
  const toggle = page.getByTestId("share-menu-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByTestId("share-menu");
  await menu.getByTestId("share-menu-copy").click();
  await expect(menu.getByTestId("share-menu-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    new RegExp(`/p/nebula-${FOUNDER.slice(0, 16)}$`),
  );
  await expect(menu.getByTestId("share-card-download")).toBeVisible();

  // The weekly calendar file links to the project and opens the update form.
  const download = page.waitForEvent("download");
  await menu.getByRole("button", { name: "Add a weekly reminder" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("weekly-update-nebula.ics");
  const ics = (await readFile(await file.path(), "utf8")).replace(/\r\n /g, "");
  expect(ics).toContain(
    `URL:http://127.0.0.1:${new URL(page.url()).port}/launchpad/nebula?author=${FOUNDER}&action=update\r\n`,
  );
  // Escape puts the list away and the keyboard back on the button that opened it.
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  // A visitor gets the same control without the reminder, which is the founder's own.
  await openAs(page, VISITOR_KEY, PROJECT);
  await page.getByTestId("share-menu-toggle").click();
  await expect(page.getByTestId("share-menu-copy")).toBeVisible();
  await expect(page.getByTestId("share-menu-reminder")).toHaveCount(0);
});
test("the welcome card can be put away, and a reload or a shared copy of the address does not bring it back", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(STARTED);
  await expect(page.getByTestId("started-card")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("started-dismiss").click();
  await expect(page.getByTestId("started-card")).toHaveCount(0);
  await expect(page).not.toHaveURL(/started=/);
  // The first-week list stays: it is the next step, not a welcome.
  await expect(page.getByTestId("first-week")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("first-week")).toBeVisible();
  await expect(page.getByTestId("started-card")).toHaveCount(0);
});

test("only the number 1 welcomes: the plain address, ?started=2 and a visitor with ?started=1 show no welcome", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("first-week")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("started-card")).toHaveCount(0);
  await page.goto(`${PROJECT}&started=2`);
  await expect(page.getByTestId("first-week")).toBeVisible();
  await expect(page.getByTestId("started-card")).toHaveCount(0);

  // Someone else opening a copy of the founder's address sees the project, not the founder's welcome or list.
  await openAs(page, VISITOR_KEY, STARTED);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nebula");
  await expect(page.getByTestId("project-goal")).toBeVisible();
  for (const id of [
    "started-card",
    "first-week",
    "recovery-key-prompt",
    "project-tasks",
    "project-team",
    "project-record",
    "set-up-more",
  ])
    await expect(page.getByTestId(id)).toHaveCount(0);
});

test("Tasks and Team are on the page from the start, the founder adds a person from Team, and there is no Set up more", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("project-team")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("set-up-more")).toHaveCount(0);
  await expect(page.getByTestId("project-tasks")).toBeVisible();
  await expect(page.getByTestId("tasks-empty")).toContainText(
    "Nothing to do yet.",
  );
  await expect(page.getByTestId("tasks-empty")).toContainText(
    "What is one thing you can finish today?",
  );
  await expect(page.getByTestId("project-record")).toHaveCount(0);
  const alone = page.getByTestId("team-alone");
  await expect(alone).toContainText(
    "It is just you for now, and that is fine.",
  );
  await expect(alone).toContainText(
    "You can run the project on your own. Add a person when you want a second pair of eyes.",
  );
  // One "Add a person" button, in the empty state.
  await expect(page.getByTestId("team-add")).toHaveCount(1);
  await page.getByTestId("team-add").click();
  await expect(page.getByTestId("team-add-warning")).toContainText(
    "They can act for this project as soon as you add them.",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "They can post updates and check work. Goals and promises stay yours.",
  );
  await expect(page.getByTestId("team-add-alone")).toHaveText(
    "Once someone else is on the project, they check work instead of you.",
  );
});
test("a team member on the record brings in the Team card as it is, and the tasks card is there too", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [
    ["team", VISITOR, "member"],
    ["team-invite", VISITOR, "inv1"],
    ["p", VISITOR],
  ]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("project-team")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("team-add")).toBeVisible();
  await expect(page.getByTestId("project-tasks")).toBeVisible();
  // Someone else is on the project: no "It is just you" line, and no solo button to add what you did.
  await expect(page.getByTestId("team-alone")).toHaveCount(0);
  await expect(page.getByTestId("first-week-add")).toHaveCount(0);
  await expect(page.getByTestId("project-record")).toHaveCount(0);
  await expect(page.getByTestId("set-up-more")).toHaveCount(0);
});
test("the first update ends the first week: 3 of 3, one line with the next date, then Ask for help", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-post").click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("update-draft-button")).toBeVisible();
  const title = dialog.getByLabel("Title");
  if (await title.isVisible()) await title.fill("Week one");
  await dialog
    .getByLabel("What happened this week")
    .fill("Set up the project.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => founderUpdates(relay).length).toBe(1);

  // The note after posting: week one, and the share picture beside the words.
  const note = page.getByTestId("update-posted");
  await expect(note).toBeVisible();
  await expect(note.getByTestId("update-posted-streak")).toHaveText(
    "That's week one. Post again next week and your run begins.",
  );
  await expect(note.getByTestId("share-card-download")).toBeVisible();
  await note.getByRole("button", { name: "Done" }).click();

  // The card becomes one line: all three steps ticked, and when the next update is due.
  const week = page.getByTestId("first-week");
  await expect(week.getByTestId("first-week-count")).toHaveText("3 of 3");
  await expect(week.getByTestId("first-week-done-line")).toHaveText(
    /^First week done\. Next update: \w{3}, \w{3} \d{1,2}\.$/,
  );
  // The update itself, and the help it asks for, stay on the page under the one line.
  await expect(page.getByTestId("project-update-card")).toBeVisible();
  // The header's button is the page's green one now, with the words of the weekly update.
  await expect(page.getByTestId("launch-post-update")).toHaveText(
    "Post this week's update",
  );
  await expect(page.getByTestId("launch-post-update")).toHaveClass(
    /bg-primary/,
  );

  // "Bring someone along": copy the link, or ask for help (which opens the update form).
  await expect(week).toContainText("Bring someone along");
  await week.getByTestId("first-week-copy-link").click();
  await expect(week.getByTestId("first-week-copy-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  await week.getByTestId("first-week-help").click();
  await expect(page.getByRole("dialog", { name: "Post update" })).toBeVisible();
});
test("the post button on the first-week card also has Draft from the record, as the page's own Post update does", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-post").click();
  await expect(
    page
      .getByRole("dialog", { name: "Post update" })
      .getByTestId("update-draft-button"),
  ).toBeVisible();
});

test("the reminder's address opens the founder's update form once, and nobody else's", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(`${PROJECT}&action=update`);
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  // The address is the plain project address afterwards: closing the form and reloading does not open it again.
  await expect(page).not.toHaveURL(/action=/);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await expect(page.getByTestId("first-week")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A visitor who follows the same address gets the page, no form.
  await openAs(page, VISITOR_KEY, `${PROJECT}&action=update`);
  await expect(page.getByTestId("project-goal")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Nobody signed in gets the page too.
  await openAs(page, null, `${PROJECT}&action=update`);
  await expect(page.getByTestId("project-goal")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a run of weeks without two answered promises is not stated in the note or in the words that are shared", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay, [], 60);
  // Weekly updates 7 and 14 days ago that made no promises: three weeks in a row once this one is posted.
  for (const ago of [7, 14])
    relay.seed(
      event(
        47003,
        FOUNDER,
        { title: `Week ${ago}`, body: "" },
        [
          ["a", COORD],
          ["update-kind", "weekly"],
        ],
        now() - ago * DAY,
      ),
    );
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page
    .getByTestId("project-update-card")
    .getByRole("button", { name: "Post one" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await dialog.getByLabel("Title").fill("Week three");
  await dialog.getByLabel("What happened this week").fill("Kept going.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  const note = page.getByTestId("update-posted");
  await expect(note.getByTestId("update-posted-streak")).toHaveText(
    "It's on your project's record. Post again next week to keep it going.",
  );
  await note.getByTestId("share-record").click();
  await expect(note.getByTestId("share-record-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  const words = await page.evaluate(() => navigator.clipboard.readText());
  expect(words).toContain("Nebula on Creaton");
  expect(words).not.toContain("weeks in a row");
});

test("the first-week card asks for the recovery key in one quiet line until it is saved, and Tab reaches it", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await notBackedUp(page, true);
  await page.goto(STARTED);
  const prompt = page.getByTestId("recovery-key-prompt");
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt).toContainText(
    "Save your recovery key so you can get back in.",
  );
  // On the first screen, inside the card, and an outline button while no update is posted: the card's green is the work.
  const box = await prompt.boundingBox();
  expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
  await expect(page.getByTestId("first-week")).toContainText(
    "Save your recovery key",
  );
  await expect(prompt.getByTestId("recovery-key-save")).not.toHaveClass(
    /bg-primary/,
  );
  await expect(page.getByTestId("recovery-key-later")).toHaveCount(0);
  // From the keyboard: Tab reaches "Save it", and Enter opens the key's dialog.
  const save = prompt.getByTestId("recovery-key-save");
  for (let i = 0; i < 60; i++) {
    if (await save.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("backup-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("backup-copy").click();
  await expect(dialog.getByTestId("backup-copy")).toContainText("Copied");
  await dialog.getByTestId("backup-close").click();
  // Saved: the line is gone and stays gone.
  await expect(prompt).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("first-week")).toBeVisible();
  await expect(page.getByTestId("recovery-key-prompt")).toHaveCount(0);
});
test("the recovery line is on the first-week card of any visit, not only the one right after Start", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await notBackedUp(page);
  await page.goto(PROJECT);
  await expect(page.getByTestId("first-week")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("recovery-key-prompt")).toBeVisible();
  await expect(page.getByTestId("recovery-key-later")).toHaveCount(0);
});
test("when an agent is on the team, a line says who answers for it; with no agent there is no line", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [
    ["team", AGENT, "member"],
    ["team-invite", AGENT, "inv1"],
    ["p", AGENT],
  ]);
  relay.seed(
    event(
      47003,
      AGENT,
      { title: "Joined the team", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 20 * DAY,
    ),
  );
  // The operator's signed word that the agent is theirs.
  const proof = bytesToHex(
    schnorr.sign(
      sha256(new TextEncoder().encode(`nostr:agent-auth:${AGENT}:kind=0`)),
      hexToBytes(VISITOR_KEY),
    ),
  );
  relay.seed(
    event(
      0,
      AGENT,
      { name: "Scout" },
      [
        ["agent", AGENT],
        ["auth", VISITOR, "kind=0", proof],
      ],
      now() - 30 * DAY,
    ),
  );
  await install(page, relay, null);
  await page.goto(PROJECT);
  await expect(page.getByTestId("agent-work-note")).toHaveText(
    "Some of this work is done by agents. Robin Owner answers for them.",
    { timeout: 20_000 },
  );

  const plain = createMockRelay();
  seedNew(plain, [
    ["team", VISITOR, "member"],
    ["team-invite", VISITOR, "inv1"],
    ["p", VISITOR],
  ]);
  const second = await page.context().newPage();
  await install(second, plain, null);
  await second.goto(PROJECT);
  await expect(second.getByTestId("project-goal")).toBeVisible({
    timeout: 20_000,
  });
  await expect(second.getByTestId("project-team")).toBeVisible();
  await expect(second.getByTestId("agent-work-note")).toHaveCount(0);
});

test("an AI project's founder gets the commands for an agent to post updates, closed until opened; nobody else does", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay, [["t", "AI agent or tool"]]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const card = page.getByTestId("agent-post-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("heading")).toHaveText(
    "Post updates from your agent",
  );
  await expect(card).toContainText(
    "Evidence can be a link, a file or a run result.",
  );
  // The command text is not on the page until someone asks for it: a closed disclosure, named in plain words.
  const commands = card.getByTestId("agent-post-commands");
  const toggle = card.getByRole("button", { name: "For agents: the commands" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(commands).toBeHidden();
  await expect(card.getByTestId("agent-post-copy")).toBeHidden();
  // From the keyboard: Enter opens it, and the button says so to a screen reader and names what it opened.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await toggle.getAttribute("aria-controls")).toBe(
    await card.getByTestId("agent-post-details").getAttribute("id"),
  );
  await expect(commands).toBeVisible();
  await expect(commands).toContainText(
    `buzz launchpad updates facts nebula --author ${FOUNDER}`,
  );
  await expect(commands).toContainText(
    `buzz launchpad updates post nebula --author ${FOUNDER} --title "Week 1"`,
  );
  await expect(commands).toContainText("--no-promises");
  await card.getByTestId("agent-post-copy").click();
  await expect(card.getByTestId("agent-post-status")).toHaveText("Copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toHaveLength(2);
  expect(copied).toContain("buzz launchpad updates post nebula");

  // A visitor to the same project, and the founder of a project that is not about AI, do not get it.
  await openAs(page, VISITOR_KEY, PROJECT);
  await expect(page.getByTestId("project-goal")).toBeVisible();
  await expect(page.getByTestId("agent-post-card")).toHaveCount(0);

  const other = createMockRelay();
  seedNew(other, [["t", "Software"]]);
  // Pages of one browser share what it stores: this one is the founder again.
  await page.evaluate(
    (key) => localStorage.setItem("e2e.key", key),
    FOUNDER_KEY,
  );
  const second = await context.newPage();
  await install(second, other, FOUNDER_KEY);
  await second.goto(PROJECT);
  await expect(second.getByTestId("first-week")).toBeVisible({
    timeout: 20_000,
  });
  await expect(second.getByTestId("agent-post-card")).toHaveCount(0);
});

test("an AI project's first update offers a kind's three first promises for What's next; the founder edits them and nothing is sent until they publish", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [["t", "AI agent or tool"]]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-post").click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  const starters = dialog.getByTestId("update-starters");
  await expect(starters).toBeVisible({ timeout: 20_000 });
  const next = dialog.getByLabel("What's next");
  await expect(next).toHaveValue("");
  // The kind is not kept on the project, so all four are offered by name; the keyboard presses one.
  await expect(starters.getByRole("button")).toHaveText([
    "AI app",
    "Agent or tool",
    "Dataset or benchmark",
    "AI media",
  ]);
  const tool = starters.getByRole("button", { name: "Agent or tool" });
  await expect(tool).toHaveAttribute("aria-pressed", "false");
  await tool.focus();
  await page.keyboard.press("Enter");
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  await expect(next).toHaveValue(
    [
      "Write down the one job it does, and what it will never do.",
      "Run it on ten real jobs and publish what it got right and wrong.",
      "Name the person who answers for its work and how to reach them.",
    ].join("\n"),
  );
  // Pressing it again clears the box; another kind replaces an unedited starter.
  await tool.click();
  await expect(next).toHaveValue("");
  await starters.getByRole("button", { name: "AI app" }).click();
  await expect(next).toHaveValue(/^Put a first working version online/);
  await tool.click();
  await expect(next).toHaveValue(/^Write down the one job it does/);
  // Filling a box sends nothing.
  expect(founderUpdates(relay)).toHaveLength(0);
  // The founder's own words: the starters step aside and can no longer replace them.
  await next.fill(
    "Write down the one job it does.\nRun it on three real jobs and publish the results.",
  );
  await expect(starters).toHaveCount(0);
  await dialog.getByLabel("Title").fill("Week one");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => founderUpdates(relay).length).toBe(1);
  // What was signed is what the founder left in the box, as two promises.
  expect(
    founderUpdates(relay)[0]
      .tags.filter((t) => t[0] === "promise")
      .map((t) => t[2]),
  ).toEqual([
    "Write down the one job it does.",
    "Run it on three real jobs and publish the results.",
  ]);

  // The second update is not a first one: no starters.
  await page
    .getByTestId("update-posted")
    .getByRole("button", { name: "Done" })
    .click();
  await page.goto(`${PROJECT}&action=update`);
  const again = page.getByRole("dialog", { name: "Post update" });
  await expect(again.getByTestId("update-due")).toBeVisible({
    timeout: 20_000,
  });
  await expect(again.getByTestId("update-starters")).toHaveCount(0);
});

test("a project that is not about AI gets no starter promises and no starter tasks", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [["t", "Software"]]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-post").click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-draft-button")).toBeVisible({
    timeout: 20_000,
  });
  await expect(dialog.getByLabel("What's next")).toBeVisible();
  await expect(dialog.getByTestId("update-starters")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("give-task").click();
  await expect(page.getByTestId("direct-task-form")).toBeVisible();
  await expect(page.getByTestId("task-starters")).toHaveCount(0);
});

test("an AI project's task form offers starter tasks: a kind, then one press fills the task and its finish line", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay, [["t", "AI agent or tool"]]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("give-task").click();
  const form = page.getByTestId("direct-task-form");
  const starters = form.getByTestId("task-starters");
  await expect(starters).toBeVisible();
  await expect(form.getByTestId("task-starter")).toHaveCount(0);
  const kind = starters.getByRole("button", { name: "Dataset or benchmark" });
  await kind.click();
  await expect(kind).toHaveAttribute("aria-pressed", "true");
  const tasks = form.getByTestId("task-starter");
  await expect(tasks).toHaveCount(5);
  await tasks.nth(1).click();
  await expect(form.getByLabel("What is the task")).toHaveValue(
    "Collect the first 100 examples with their sources",
  );
  await expect(form.getByLabel("Done means")).toHaveValue(
    "A file of 100 examples, each with a link or note saying where it came from.",
  );
  await expect(tasks.nth(1)).toHaveAttribute("aria-pressed", "true");
  // Nothing is made by the press: the task is a record only once the form is sent.
  expect(
    relay.events.filter(
      (e) =>
        e.pubkey === FOUNDER && e.created_at > now() - 60 && e.kind !== 47003,
    ),
  ).toHaveLength(0);
  // The founder's own words put the suggestions away.
  await form.getByLabel("Done means").fill("A file of 80 examples.");
  await expect(starters).toHaveCount(0);
});

test("at 390px the live line, the first-week card and the tasks fit with no sideways scroll, and every tap is 44px high", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay();
  seedNew(relay, [["t", "AI agent or tool"]]);
  await install(page, relay, FOUNDER_KEY);
  await notBackedUp(page);
  await page.goto(STARTED);
  await expect(page.getByTestId("started-card")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("first-week")).toBeVisible();
  await expect(page.getByTestId("recovery-key-prompt")).toBeVisible();
  await expect(page.getByTestId("agent-post-card")).toBeVisible();
  await expect(page.getByTestId("project-team")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  for (const id of [
    "started-copy",
    "first-week-add",
    "first-week-plan",
    "first-week-post",
    "recovery-key-save",
    "share-menu-toggle",
  ]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(43.5);
  }
  // The update form's "Draft from the record" explains itself in a line you can read, below its button on a phone.
  await page.getByRole("button", { name: "Post update" }).first().click();
  const draft = page.getByTestId("update-draft");
  await expect(draft).toBeVisible();
  const note = await draft.locator("p").first().boundingBox();
  expect(note?.width ?? 0).toBeGreaterThanOrEqual(250);
});
