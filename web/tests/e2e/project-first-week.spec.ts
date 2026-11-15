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

test("a founder lands on the live project with one welcome card and one first-week list, and no empty cards", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(STARTED);

  const welcome = page.getByTestId("started-card");
  await expect(welcome).toBeVisible({ timeout: 20_000 });
  await expect(welcome.getByRole("heading")).toHaveText("Your project is live");
  await expect(welcome.getByTestId("started-first-update")).toHaveText(
    "Your first update is due in 7 days.",
  );
  await expect(welcome.getByTestId("started-follow")).toContainText(
    "Ask three people to follow",
  );

  // The public link, and the two ways to hand it on.
  const link = await welcome.getByTestId("started-link").inputValue();
  expect(link).toMatch(new RegExp(`/p/nebula-${FOUNDER.slice(0, 16)}$`));
  await welcome.getByTestId("started-copy").click();
  await expect(welcome.getByTestId("started-copy-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await welcome.getByTestId("share-record").click();
  await expect(welcome.getByTestId("share-record-status")).toHaveText(
    "Copied. Paste it anywhere.",
  );
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  expect(shared).toContain("Nebula on Creaton: just started.");
  expect(shared).toContain(link);
  expect(shared).not.toMatch(/earn|price|\$|return/i);
  await expect(welcome.getByTestId("share-card-download")).toBeVisible();

  // The weekly calendar file links to the project and opens the update form.
  const download = page.waitForEvent("download");
  await welcome.getByRole("button", { name: "Add a weekly reminder" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("weekly-update-nebula.ics");
  const ics = (await readFile(await file.path(), "utf8")).replace(/\r\n /g, "");
  expect(ics).toContain(
    `URL:http://127.0.0.1:${new URL(page.url()).port}/launchpad/nebula?author=${FOUNDER}&action=update\r\n`,
  );

  // One list of next steps: the goal is ticked, and nothing else asks for the first update.
  const week = page.getByTestId("first-week");
  await expect(week.getByRole("heading")).toHaveText("First week");
  // The welcome card above already says when the first update is due, so this card does not say it a second time.
  await expect(week.getByTestId("first-week-due")).toHaveText(
    "A few lines are enough.",
  );
  await expect(
    week.locator("li", { hasText: "Set your goal" }),
  ).toHaveAttribute("data-done", "true");
  await expect(week.locator("li[data-done=false]")).toHaveCount(3);
  await expect(page.getByTestId("project-update-card")).toHaveCount(0);
  await expect(page.getByTestId("update-nudge")).toHaveCount(0);

  // No wall of empty cards: tasks, team and record are not on the page, and one button brings them in.
  for (const id of ["project-tasks", "project-team", "project-record"])
    await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId("set-up-more")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "the project page in its first week");
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

test("Set up more brings in Tasks, Team and Record, and the founder can add a team member from it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("set-up-more")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("team-add")).toHaveCount(0);
  await page.getByTestId("set-up-more").click();

  await expect(page.getByTestId("project-team")).toBeVisible();
  await expect(page.getByTestId("team-alone")).toContainText(
    "It is just you for now.",
  );
  await expect(page.getByTestId("project-tasks")).toBeVisible();
  await expect(page.getByTestId("project-record")).toBeVisible();
  // Everything is on the page: nothing is left to set up.
  await expect(page.getByTestId("set-up-more")).toHaveCount(0);
  await page.getByTestId("team-add").click();
  await expect(page.getByTestId("team-add-warning")).toBeVisible();
});

test("a card appears on its own once it has something: a team member brings in the Team card", async ({
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
  await expect(page.getByTestId("project-tasks")).toHaveCount(0);
  await expect(page.getByTestId("project-record")).toHaveCount(0);
  // The founder can still bring in the other two.
  await expect(page.getByTestId("set-up-more")).toBeVisible();
});

test("Ask for help opens the update form at Help needed, with Draft from the record; the first update ends the first week", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("first-week-help").click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/Help needed/)).toBeFocused();
  await expect(dialog.getByTestId("update-draft-button")).toBeVisible();
  await dialog.getByLabel("Title").fill("Week one");
  await dialog
    .getByLabel("What happened this week")
    .fill("Set up the project.");
  await dialog
    .getByLabel(/Help needed/)
    .fill("Someone to test sign-up on an older phone.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => founderUpdates(relay).length).toBe(1);
  expect(
    founderUpdates(relay)[0].tags.some((t) => t[0] === "help-needed"),
  ).toBe(true);

  // The note after posting: week one, and the share picture beside the words.
  const note = page.getByTestId("update-posted");
  await expect(note).toBeVisible();
  await expect(note.getByTestId("update-posted-streak")).toHaveText(
    "That's week one. Post again next week and your run begins.",
  );
  await expect(note.getByTestId("share-card-download")).toBeVisible();
  await note.getByRole("button", { name: "Done" }).click();

  // The first week is over: its card gives way to the update card.
  await expect(page.getByTestId("first-week")).toHaveCount(0);
  await expect(page.getByTestId("project-update-card")).toBeVisible();
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

test("the first page asks for the recovery key until it is saved, and not on any other page", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = createMockRelay();
  seedNew(relay);
  await install(page, relay, FOUNDER_KEY);
  await notBackedUp(page, true);
  await page.goto(STARTED);
  const prompt = page.getByTestId("recovery-key-prompt");
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt.getByRole("heading")).toHaveText(
    "Save your recovery key",
  );
  await prompt.getByTestId("recovery-key-save").click();
  const dialog = page.getByTestId("backup-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("backup-copy").click();
  await expect(dialog.getByTestId("backup-copy")).toContainText("Copied");
  await dialog.getByTestId("backup-close").click();
  // Saved: the prompt is gone and stays gone.
  await expect(prompt).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("first-week")).toBeVisible();
  await expect(page.getByTestId("recovery-key-prompt")).toHaveCount(0);
});

test("the recovery prompt can wait for this visit, and a project page that was not just started does not ask", async ({
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
  await expect(page.getByTestId("recovery-key-prompt")).toHaveCount(0);
  await page.goto(STARTED);
  await page.getByTestId("recovery-key-later").click();
  await expect(page.getByTestId("recovery-key-prompt")).toHaveCount(0);
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

test("at 390px the welcome, the first-week list and the set-up row fit with no sideways scroll", async ({
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
  expect(await noSidewaysScroll(page)).toBe(true);
  // The link is the point of the welcome card: wide enough to read, not squeezed beside three buttons.
  const link = await page.getByTestId("started-link").boundingBox();
  expect(link?.width ?? 0).toBeGreaterThanOrEqual(190);
  await page.getByTestId("set-up-more").click();
  await expect(page.getByTestId("project-team")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  // The update form's "Draft from the record" explains itself in a line you can read, below its button on a phone.
  await page.getByRole("button", { name: "Post update" }).first().click();
  const draft = page.getByTestId("update-draft");
  await expect(draft).toBeVisible();
  const note = await draft.locator("p").first().boundingBox();
  expect(note?.width ?? 0).toBeGreaterThanOrEqual(250);
});
