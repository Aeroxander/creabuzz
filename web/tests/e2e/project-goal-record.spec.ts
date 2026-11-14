import { expect, test, type Page } from "@playwright/test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { COMMUNITY_HOST, createMockRelay, matches } from "./mock-relay";

/**
 * A project keeps its promises on the record: starting one alone with four answers, the goal on its page and what
 * became of it, the promises each update makes and the next one answers, and the record everyone reads. Around it: who
 * sees which tabs, what a visitor without an account gets, sends the server refuses, reads that fail or are cut short,
 * and a phone-width screen.
 *
 * One mock server holds every record across the people in a test; a person is swapped by changing whose key the page
 * has and loading again, so what each sees is read back from the server, never from the other's page memory.
 */

const FOUNDER_KEY = "6".repeat(64);
const VISITOR_KEY = "7".repeat(64);
const pubkeyOf = (key: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(key, "hex")));
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const VISITOR = pubkeyOf(VISITOR_KEY);
const COORD = `37001:${FOUNDER}:nebula`;
const PROJECT = `/launchpad/nebula?author=${FOUNDER}`;
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

type Relay = ReturnType<typeof createMockRelay>;

let sequence = 0;
function event(
  kind: number,
  pubkey: string,
  content: unknown,
  tags: string[][],
  at: number,
) {
  sequence += 1;
  return {
    id: sequence.toString(16).padStart(64, "0"),
    kind,
    pubkey,
    content: typeof content === "string" ? content : JSON.stringify(content),
    tags,
    created_at: at,
    sig: "0".repeat(128),
  };
}

/** A project with no Shares and no sale, as the short Start form makes it. */
function seedProject(relay: Relay, at = now() - 60 * DAY) {
  relay.seed(
    event(
      37001,
      FOUNDER,
      { pitch: "A map of the night sky for everyone.", stage: "draft" },
      [
        ["d", "nebula"],
        ["name", "Nebula"],
        ["t", "dao-launchpad"],
        ["admission", "curated"],
      ],
      at,
    ),
  );
}

/** A goal record as the app publishes it. */
function seedGoal(
  relay: Relay,
  at: number,
  goal: {
    id?: string;
    level?: string;
    text: string;
    how?: string;
    state?: string;
    reason?: string;
  },
  pubkey = FOUNDER,
) {
  const record = event(
    47003,
    pubkey,
    { title: "Goal", body: goal.text },
    [
      ["a", COORD],
      ["goal", goal.id ?? "g1"],
      ["goal-level", goal.level ?? "primary"],
      ["goal-text", goal.text],
      ["goal-how", goal.how ?? "Ten people sign in during one week"],
      ["goal-state", goal.state ?? "open"],
      ...(goal.reason ? [["goal-reason", goal.reason]] : []),
    ],
    at,
  );
  relay.seed(record);
  return record;
}

/** An update with promises, as the dialog publishes it. */
function seedUpdate(
  relay: Relay,
  at: number,
  title: string,
  promises: string[],
  marks: string[][] = [],
) {
  const update = event(
    47003,
    FOUNDER,
    { title, body: `What's next\n${promises.join("\n")}` },
    [
      ["a", COORD],
      ...(promises.length > 0
        ? [["update-part", "next", promises.join("\n")]]
        : []),
      ...promises.map((text, i) => ["promise", String(i), text]),
      ...marks,
      // As the dialog writes it when an update answers no prompt.
      ...(promises.length + marks.length === 0
        ? [["update-kind", "weekly"]]
        : []),
    ],
    at,
  );
  relay.seed(update);
  return update;
}

async function install(page: Page, relay: Relay, key: string | null) {
  await relay.install(page);
  await page.addInitScript((first) => {
    const key = localStorage.getItem("e2e.key") ?? first;
    if (key === null || key === "none") {
      localStorage.removeItem("buzz.identity.nsec");
      return;
    }
    localStorage.setItem("buzz.identity.nsec", key);
    localStorage.setItem("buzz.identity.backedUp", "1");
  }, key);
  await page.route("**/communities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: COMMUNITY_HOST,
            name: "Alpha",
            description: "Build together",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    }),
  );
  await page.route("**/query", (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        relay.events.filter((e) =>
          filters.some((f: Parameters<typeof matches>[0]) => matches(f, e)),
        ),
      ),
    });
  });
}

/** Become another person (or nobody) and open `path` as them. */
async function openAs(page: Page, key: string | null, path: string) {
  await page.evaluate(
    (next) => localStorage.setItem("e2e.key", next ?? "none"),
    key,
  );
  await page.goto(path);
}

const records = (relay: Relay, kind: number) =>
  relay.events.filter((e) => e.kind === kind && e.pubkey === FOUNDER);
const tagged = (relay: Relay, name: string) =>
  relay.events.filter((e) => e.tags.some((t) => t[0] === name));
const tagsNamed = (e: { tags: string[][] }, name: string) =>
  e.tags.filter((t) => t[0] === name);
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("one person starts a project alone with four answers and lands on its page with the goal", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  await install(page, relay, FOUNDER_KEY);
  await page.goto("/start");

  // The short form is the first thing; every other way to start is behind one disclosure, still reachable.
  const form = page.getByTestId("quick-start");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("start-go-contributor")).toBeHidden();
  // Only four things are asked.
  await expect(form.locator("input, textarea, select")).toHaveCount(4);

  // Each missing answer is named, and nothing is sent.
  await form.getByRole("button", { name: "Start the project" }).click();
  await expect(form.getByTestId("quick-issue")).toHaveText(
    "Give your project a name.",
  );
  await form.getByLabel("Project name").fill("Nebula");
  await form
    .getByLabel("What is it, in one sentence?")
    .fill("A map of the night sky for everyone.");
  await form.getByLabel("The goal").fill("A first version ten people use");
  await form.getByRole("button", { name: "Start the project" }).click();
  await expect(form.getByTestId("quick-issue")).toHaveText(
    "Say how we'll know it was reached.",
  );
  expect(records(relay, 37001)).toHaveLength(0);

  // The last answer, then Enter in a one-line box starts it: the keyboard path, not the button.
  await form.getByLabel("How we'll know").fill("Ten people sign in in a week");
  await form.getByLabel("Project name").press("Enter");

  await expect(page).toHaveURL(/\/launchpad\/nebula\?/);
  const goal = page.getByTestId("project-goal");
  await expect(goal.getByTestId("goal-text")).toHaveText(
    "A first version ten people use",
  );
  await expect(goal.getByTestId("goal-how")).toHaveText(
    "How we'll know: Ten people sign in in a week",
  );
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nebula");

  // The project: no network, no Shares, no money, no rooms to wait for. The goal: its own record, as fields.
  const [project] = records(relay, 37001);
  // (`started` is when it was first published: what lists order by, so saving it again never moves it.)
  expect(JSON.parse(project.content)).toEqual({
    pitch: "A map of the night sky for everyone.",
    stage: "draft",
    started: expect.any(Number),
  });
  for (const name of ["chain", "token", "treasury", "auction", "buzz-channel"])
    expect(tagsNamed(project, name), name).toEqual([]);
  const [goalRecord] = tagged(relay, "goal");
  expect(goalRecord.kind).toBe(47003);
  expect(goalRecord.tags).toEqual([
    ["a", COORD],
    ["goal", expect.stringMatching(/^g[a-z0-9]{10}$/)],
    ["goal-level", "primary"],
    ["goal-text", "A first version ten people use"],
    ["goal-how", "Ten people sign in in a week"],
    ["goal-state", "open"],
  ]);
  // A goal is not news: it is not counted as a weekly update.
  await expect(page.getByTestId("update-nudge")).toContainText(
    "You haven't posted an update yet.",
  );

  // The other ways to start are one press away.
  await page.goto("/start");
  await page.getByText("More ways to start").click();
  await expect(page.getByTestId("start-go-contributor")).toBeVisible();
  await expect(page.getByTestId("start-steps")).toBeVisible();
});

test("when the goal is not saved the project is not made twice: Try again sends only the goal", async ({
  page,
}) => {
  let refusing = true;
  const relay = createMockRelay({
    refuse: (e) => (refusing && e.kind === 47003 ? "blocked: try later" : null),
  });
  await install(page, relay, FOUNDER_KEY);
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill("Nebula");
  await form
    .getByLabel("What is it, in one sentence?")
    .fill("A map of the night sky for everyone.");
  await form.getByLabel("The goal").fill("A first version ten people use");
  await form.getByLabel("How we'll know").fill("Ten people sign in in a week");
  await form.getByRole("button", { name: "Start the project" }).click();

  await expect(form.getByTestId("quick-failed")).toContainText(
    "Your project was made, but its goal was not saved.",
  );
  // What was written is still there, and the project can be opened as it is.
  await expect(form.getByLabel("The goal")).toHaveValue(
    "A first version ten people use",
  );
  await expect(form.getByTestId("quick-made")).toContainText(
    "Open your project",
  );
  expect(records(relay, 37001)).toHaveLength(1);
  expect(tagged(relay, "goal")).toHaveLength(0);

  refusing = false;
  await form.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/\/launchpad\/nebula\?/);
  await expect(page.getByTestId("goal-text")).toHaveText(
    "A first version ten people use",
  );
  expect(records(relay, 37001)).toHaveLength(1);
  expect(tagged(relay, "goal")).toHaveLength(1);
});

test("an update's next steps are promises; the next update answers each, and everyone sees the record", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedProject(relay);
  seedGoal(relay, now() - 30 * DAY, { text: "A first version ten people use" });
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);

  // Nothing promised yet: the record says how it fills.
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-empty")).toContainText(
    "No promises yet.",
  );

  // First update: three next steps, one per line.
  await page.getByRole("button", { name: "Post update" }).click();
  let dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-due")).toHaveCount(0);
  await dialog.getByLabel("Title").fill("Week one");
  await dialog.getByLabel("What happened this week").fill("Set up the repo.");
  await dialog
    .getByLabel("What's next")
    .fill("- Ship sign-up\n- Write the guide\n\n- Find a designer");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => tagged(relay, "promise").length).toBe(1);
  const first = tagged(relay, "promise")[0];
  expect(tagsNamed(first, "promise")).toEqual([
    ["promise", "0", "Ship sign-up"],
    ["promise", "1", "Write the guide"],
    ["promise", "2", "Find a designer"],
  ]);
  // Waiting for the next update: listed, not counted as anything yet.
  await expect(record.getByTestId("record-line")).toHaveCount(3);
  await expect(record.getByTestId("record-line").first()).toContainText(
    "Promised",
  );
  await expect(record.getByTestId("record-totals")).toHaveCount(0);

  // Second update: the dialog lists last time's promises and asks about each.
  await page.getByRole("button", { name: "Post update" }).click();
  dialog = page.getByRole("dialog", { name: "Post update" });
  const due = dialog.getByTestId("update-due-promise");
  await expect(due).toHaveCount(3);
  const answer = (text: string) => dialog.getByRole("group", { name: text });
  // One tap each; the middle one from the keyboard (the radios are one group, moved through with the arrow keys).
  await answer("Ship sign-up")
    .getByRole("radio", { name: "Done", exact: true })
    .check();
  await answer("Write the guide")
    .getByRole("radio", { name: "Done", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    answer("Write the guide").getByRole("radio", { name: "Not done" }),
  ).toBeChecked();
  await dialog
    .getByLabel("Short note for: Write the guide")
    .fill("ran out of time");
  await answer("Find a designer")
    .getByRole("radio", { name: "Changed" })
    .check();
  await dialog
    .getByLabel("Short note for: Find a designer")
    .fill("doing it ourselves");
  await dialog.getByLabel("Title").fill("Week two");
  await dialog.getByLabel("What's next").fill("Invite ten people");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => tagged(relay, "promise-mark").length).toBe(1);
  const second = tagged(relay, "promise-mark")[0];
  expect(tagsNamed(second, "promise-mark")).toEqual([
    ["promise-mark", `${first.id}:0`, "done", ""],
    ["promise-mark", `${first.id}:1`, "not-done", "ran out of time"],
    ["promise-mark", `${first.id}:2`, "changed", "doing it ourselves"],
  ]);
  // The answers read as words too, for any app that only shows an update's body.
  expect(JSON.parse(second.content).body).toContain(
    "What we said last time\nDone: Ship sign-up\nNot done: Write the guide (ran out of time)\nChanged: Find a designer (doing it ourselves)",
  );

  // The record: totals, and each promise with what came of it. The miss is there with its note.
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "1 kept, 1 missed, 1 changed",
  );
  const lines = record.getByTestId("record-line");
  await expect(lines).toHaveCount(4);
  await expect(lines.filter({ hasText: "Write the guide" })).toContainText(
    "Missed",
  );
  await expect(lines.filter({ hasText: "Write the guide" })).toContainText(
    "ran out of time",
  );
  await expect(lines.filter({ hasText: "Ship sign-up" })).toContainText("Kept");
  await expect(lines.filter({ hasText: "Find a designer" })).toContainText(
    "Changed",
  );
  await expect(lines.filter({ hasText: "Invite ten people" })).toContainText(
    "For the next update",
  );
  await expectAccessible(page, "project page with a goal and a record");

  // A third update only asks about what is still open.
  await page.getByRole("button", { name: "Post update" }).click();
  dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-due-promise")).toHaveCount(1);
  await expect(dialog.getByTestId("update-due")).toContainText(
    "Invite ten people",
  );
  await expectAccessible(page, "post update dialog with promises to answer");
  await page.keyboard.press("Escape");

  // A visitor with no account reads the same record, and has no way to change it.
  await openAs(page, null, PROJECT);
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "1 kept, 1 missed, 1 changed",
  );
  await expect(page.getByRole("button", { name: "Post update" })).toHaveCount(
    0,
  );
});

test("a promise the next update did not answer shows as not answered and is asked about again", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedUpdate(relay, now() - 14 * DAY, "Week one", ["Ship sign-up"]);
  seedUpdate(relay, now() - 7 * DAY, "Week two", []);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "0 kept, 0 missed, 0 changed, 1 not answered",
  );
  await expect(record.getByTestId("record-line")).toContainText("Not answered");
  await page.getByRole("button", { name: "Post update" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Post update" })
      .getByTestId("update-due-promise"),
  ).toContainText("Ship sign-up");
});

test("someone else's records neither answer a promise nor set a goal", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedGoal(relay, now() - 30 * DAY, { text: "The founder's goal" });
  const update = seedUpdate(relay, now() - 7 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  // A stranger "answers" the promise and "changes" the goal.
  relay.seed(
    event(
      47003,
      VISITOR,
      { title: "Week two", body: "" },
      [
        ["a", COORD],
        ["promise-mark", `${update.id}:0`, "done", ""],
      ],
      now() - DAY,
    ),
  );
  seedGoal(
    relay,
    now() - DAY,
    { text: "A stranger's goal", state: "reached" },
    VISITOR,
  );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("goal-text")).toHaveText("The founder's goal");
  await expect(page.getByTestId("goal-state")).toHaveCount(0);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-line")).toContainText("Promised");
  await expect(record.getByTestId("record-totals")).toHaveCount(0);
});

test("the founder marks the goal missed with a reason; it stays on the record whatever comes after", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedProject(relay);
  seedGoal(relay, now() - 30 * DAY, { text: "A first version ten people use" });
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const goal = page.getByTestId("project-goal");
  await expect(goal.getByTestId("goal-state")).toHaveCount(0);

  await goal.getByRole("button", { name: "Update this goal" }).click();
  let dialog = page.getByRole("dialog", { name: "Update this goal" });
  await dialog.getByRole("radio", { name: "Missed" }).check();
  // A miss needs its one line of why.
  await dialog.getByRole("button", { name: "Save goal" }).click();
  await expect(dialog.getByTestId("goal-issue")).toHaveText(
    "Say in one line why it was missed.",
  );
  expect(tagged(relay, "goal")).toHaveLength(1);
  await dialog.getByLabel("Why was it missed?").fill("Sign-up took too long");
  await dialog.getByRole("button", { name: "Save goal" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(goal.getByTestId("goal-state")).toHaveText("Missed");
  await expect(goal.getByTestId("goal-reason")).toHaveText(
    "Why: Sign-up took too long",
  );
  const missed = tagged(relay, "goal").find((e) =>
    e.tags.some((t) => t[0] === "goal-state" && t[1] === "missed"),
  );
  expect(missed?.tags).toEqual([
    ["a", COORD],
    ["goal", "g1"],
    ["goal-level", "primary"],
    ["goal-text", "A first version ten people use"],
    ["goal-how", "Ten people sign in during one week"],
    ["goal-state", "missed"],
    ["goal-reason", "Sign-up took too long"],
  ]);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-goal-totals")).toHaveText(
    "0 goals reached, 1 missed, 0 changed",
  );
  await expect(record.getByTestId("record-line")).toContainText("Goal missed");
  await expect(record.getByTestId("record-line")).toContainText(
    "Why: Sign-up took too long",
  );

  // Reword it and open it again: what it was is kept, and the miss is still counted.
  await goal.getByRole("button", { name: "Update this goal" }).click();
  dialog = page.getByRole("dialog", { name: "Update this goal" });
  await dialog.getByLabel("The goal").fill("A first version five people use");
  await dialog.getByRole("radio", { name: "Open" }).check();
  await dialog.getByLabel("Why did it change?").fill("Ten was too many");
  await dialog.getByRole("button", { name: "Save goal" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(goal.getByTestId("goal-text")).toHaveText(
    "A first version five people use",
  );
  await expect(goal.getByTestId("goal-state")).toHaveCount(0);
  const history = goal.getByTestId("goal-history").first();
  await history.locator("summary").click();
  await expect(history).toContainText("Missed on");
  await expect(history).toContainText("Why: Sign-up took too long");
  await expect(history).toContainText("It was: A first version ten people use");
  await expect(record.getByTestId("record-goal-totals")).toHaveText(
    "0 goals reached, 1 missed, 0 changed",
  );
  await expect(
    record.getByTestId("record-line").filter({ hasText: "Goal missed" }),
  ).toHaveCount(1);
  // Three records for one goal: nothing was edited in place.
  expect(tagged(relay, "goal")).toHaveLength(3);

  // A shorter goal sits under it.
  await goal.getByRole("button", { name: "Add a shorter goal" }).click();
  dialog = page.getByRole("dialog", { name: "Add a shorter goal" });
  await dialog.getByRole("radio", { name: "This week" }).check();
  await dialog.getByLabel("The goal").fill("Fix the invite email");
  await dialog.getByLabel("How we'll know").fill("A new person gets in");
  await dialog.getByRole("button", { name: "Save goal" }).click();
  await expect(dialog).toHaveCount(0);
  const shorter = goal.getByTestId("shorter-goal");
  await expect(shorter).toContainText("This week");
  await expect(shorter).toContainText("Fix the invite email");
  await expect(shorter).toContainText("How we'll know: A new person gets in");
  const week = tagged(relay, "goal").find((e) =>
    e.tags.some((t) => t[0] === "goal-level" && t[1] === "week"),
  );
  expect(tagsNamed(week as { tags: string[][] }, "goal-under")).toEqual([
    ["goal-under", "g1"],
  ]);

  // A visitor sees the goal, its history and the record, and none of the founder's buttons.
  await openAs(page, VISITOR_KEY, PROJECT);
  await expect(goal.getByTestId("goal-text")).toHaveText(
    "A first version five people use",
  );
  await expect(goal.getByTestId("goal-history").first()).toBeVisible();
  await expect(goal.getByRole("button")).toHaveCount(0);
  await expect(record.getByTestId("record-goal-totals")).toHaveText(
    "0 goals reached, 1 missed, 0 changed",
  );
});

test("a goal the server refuses stays in the dialog with what was written, and Try again saves it", async ({
  page,
}) => {
  let refusing = true;
  const relay = createMockRelay({
    refuse: (e) => (refusing && e.kind === 47003 ? "blocked: try later" : null),
  });
  seedProject(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const goal = page.getByTestId("project-goal");
  // A project with no goal asks its founder for one.
  await expect(goal.getByTestId("goal-missing")).toContainText(
    "Your project has no goal yet.",
  );
  await goal.getByRole("button", { name: "Set your goal" }).click();
  const dialog = page.getByRole("dialog", { name: "Set your goal" });
  await dialog.getByLabel("The goal").fill("Reach a hundred readers");
  await dialog.getByLabel("How we'll know").fill("A hundred people open it");
  await dialog.getByRole("button", { name: "Save goal" }).click();
  await expect(dialog.getByTestId("goal-save-failed")).toContainText(
    "Your goal was not saved.",
  );
  await expect(dialog.getByLabel("The goal")).toHaveValue(
    "Reach a hundred readers",
  );
  expect(tagged(relay, "goal")).toHaveLength(0);
  refusing = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(goal.getByTestId("goal-text")).toHaveText(
    "Reach a hundred readers",
  );
  expect(tagged(relay, "goal")).toHaveLength(1);
});

test("tabs show once the project uses them; the founder always has the way to set things up", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedGoal(relay, now() - 30 * DAY, { text: "A first version ten people use" });
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("goal-text")).toBeVisible();

  // A visitor to a project that has posted nothing and has no boards: no empty tabs.
  const tabs = page.getByRole("tablist");
  await expect(tabs.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Discussion" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /^Updates/ })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "Boards" })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "Manage" })).toHaveCount(0);
  // An old link to a tab that is not shown opens the overview, not a blank page.
  await page.goto(`${PROJECT}&tab=boards`);
  await expect(page.getByTestId("idea-overview")).toBeVisible();
  // No Shares set up: nothing about Work, Funds or Decisions anywhere on the page.
  for (const name of ["Work", "Funds", "Decisions", "Contributions"])
    await expect(tabs.getByRole("tab", { name })).toHaveCount(0);
  // The visitor's own way in: a clear Follow, and what it gives.
  await expect(page.getByTestId("launch-back-idea")).toHaveText("Follow");
  await expect(page.getByTestId("launch-follow-note")).toHaveText(
    "Follow to get this project's updates in your Home, under Updates.",
  );

  // The founder of the same project gets every tab, used or not, and the one way to set up Shares.
  await openAs(page, FOUNDER_KEY, PROJECT);
  await expect(page.getByTestId("goal-text")).toBeVisible();
  for (const name of [/^Updates/, "Boards", "Manage"])
    await expect(tabs.getByRole("tab", { name })).toBeVisible();
  const next = page.getByTestId("idea-progress");
  await expect(next).toContainText("Set up Shares for people who help");
  await expect(next).not.toContainText(/\bearn/i);
  await expect(next.getByTestId("idea-start-contributor")).toHaveAttribute(
    "href",
    "/start/contributor",
  );
  // From the keyboard: the tab is a button like the rest.
  await tabs.getByRole("tab", { name: "Boards" }).focus();
  await page.keyboard.press("Enter");
  await expect(tabs.getByRole("tab", { name: "Boards" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabs.getByRole("tab", { name: "Manage" }).click();
  await expect(tabs.getByRole("tab", { name: "Manage" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Once the project posts, the visitor gets the Updates tab.
  seedUpdate(relay, now() - DAY, "Week one", ["Ship sign-up"]);
  await openAs(page, VISITOR_KEY, PROJECT);
  await expect(tabs.getByRole("tab", { name: "Updates (1)" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Boards" })).toHaveCount(0);
});

test("a visitor with no account reads the page, and Follow or Start asks them to create an account", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedGoal(relay, now() - 30 * DAY, { text: "A first version ten people use" });
  const first = seedUpdate(relay, now() - 14 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  seedUpdate(
    relay,
    now() - 7 * DAY,
    "Week two",
    ["Invite ten people"],
    [["promise-mark", `${first.id}:0`, "not-done", "late"]],
  );
  await install(page, relay, null);
  await page.goto(PROJECT);

  await expect(page.getByTestId("goal-text")).toHaveText(
    "A first version ten people use",
  );
  await expect(page.getByTestId("latest-update")).toContainText("Week two");
  await expect(page.getByTestId("record-promise-totals")).toHaveText(
    "0 kept, 1 missed, 0 changed",
  );
  // Nothing of the founder's is offered.
  await expect(page.getByTestId("goal-update")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Post update" })).toHaveCount(
    0,
  );
  await expectAccessible(page, "project page, signed out");

  await page.getByTestId("launch-back-idea").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 10003)).toHaveLength(0);
  await page.keyboard.press("Escape");

  // Start: the form is there to read and fill; starting asks for an account and keeps what was typed.
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill("Comet");
  await form
    .getByLabel("What is it, in one sentence?")
    .fill("A tiny telescope anyone can build.");
  await form.getByLabel("The goal").fill("Ten built telescopes");
  await form.getByLabel("How we'll know").fill("Ten people post a photo");
  await form.getByRole("button", { name: "Start the project" }).click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37001)).toHaveLength(1);
  await page.reload();
  await expect(form.getByLabel("The goal")).toHaveValue("Ten built telescopes");
});

test("an offer to help from an agent is labelled as an agent, with who runs it when the record proves that", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  const ask = event(
    47003,
    FOUNDER,
    { title: "Week one", body: "Help needed (Small)\nTest sign-up." },
    [
      ["a", COORD],
      ["help-needed", "Test sign-up."],
      ["help-size", "small"],
    ],
    now() - 2 * DAY,
  );
  relay.seed(ask);
  relay.seed(event(0, VISITOR, { name: "Robin Owner" }, [], now() - 9 * DAY));
  const AGENT_KEY = "8".repeat(64);
  const OTHER_AGENT_KEY = "9".repeat(64);
  const AGENT = pubkeyOf(AGENT_KEY);
  const OTHER_AGENT = pubkeyOf(OTHER_AGENT_KEY);
  relay.seed(event(0, AGENT, { name: "Testbot" }, [], now() - 9 * DAY));
  relay.seed(event(0, OTHER_AGENT, { name: "Lonebot" }, [], now() - 9 * DAY));
  // The owner's signed word that the agent acts for them, as the app's own agent writes it.
  const conditions = "kind=47003";
  const proof = bytesToHex(
    schnorr.sign(
      sha256(
        new TextEncoder().encode(`nostr:agent-auth:${AGENT}:${conditions}`),
      ),
      hexToBytes(VISITOR_KEY),
    ),
  );
  const offer = (pubkey: string, extra: string[][], at: number) =>
    relay.seed(
      event(
        47003,
        pubkey,
        { title: "Offer to help", body: "I can run the checks." },
        [
          ["a", COORD],
          ["e", ask.id],
          ["p", FOUNDER],
          ["help-offer", ask.id],
          ...extra,
        ],
        at,
      ),
    );
  offer(
    AGENT,
    [
      ["agent", AGENT],
      ["auth", VISITOR, conditions, proof],
    ],
    now() - 3 * 3600,
  );
  // Says it is an agent, and claims an owner with a signature that does not check out: no owner is named.
  offer(
    OTHER_AGENT,
    [
      ["agent", OTHER_AGENT],
      ["auth", VISITOR, conditions, "0".repeat(128)],
    ],
    now() - 2 * 3600,
  );
  const PERSON_KEY = "a".repeat(64);
  offer(pubkeyOf(PERSON_KEY), [], now() - 3600);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const offers = page.getByTestId("help-offer");
  await expect(offers).toHaveCount(3);
  await expect(
    offers.filter({ hasText: "Testbot" }).getByTestId("help-offer-agent"),
  ).toHaveText("Agent, run by Robin Owner");
  await expect(
    offers.filter({ hasText: "Lonebot" }).getByTestId("help-offer-agent"),
  ).toHaveText("Agent");
  // A person's offer carries no such label.
  await expect(page.getByTestId("help-offer-agent")).toHaveCount(2);
});

test("when the project's records can't be read, the goal and the record say so with Try again", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedGoal(relay, now() - 30 * DAY, { text: "A first version ten people use" });
  const first = seedUpdate(relay, now() - 14 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  seedUpdate(
    relay,
    now() - 7 * DAY,
    "Week two",
    [],
    [["promise-mark", `${first.id}:0`, "not-done", "late"]],
  );
  let failing = true;
  // Only the project's own read of its records is dropped; the list of every project still answers.
  relay.setClosingSockets(
    (filter) =>
      failing &&
      Array.isArray(filter?.kinds) &&
      (filter.kinds as number[]).includes(47003) &&
      Array.isArray(filter?.["#a"]),
  );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  const failed = record.getByTestId("record-read-failed");
  await expect(failed).toContainText(
    "Couldn't read this project's promises and goals.",
    {
      timeout: 60_000,
    },
  );
  await expect(failed).toHaveAttribute("role", "alert");
  // Never "nothing on the record", never "no goal": the miss is not hidden behind a failed read.
  await expect(record.getByTestId("record-empty")).toHaveCount(0);
  await expect(page.getByTestId("goal-missing")).toHaveCount(0);
  await expect(page.getByTestId("goal-read-failed")).toContainText(
    "Couldn't read this project's goal.",
  );
  failing = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "0 kept, 1 missed, 0 changed",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("goal-text")).toHaveText(
    "A first version ten people use",
  );
});

test("when a read was cut short, the newest part of the record shows and no totals or 'no goal' are stated", async ({
  page,
}) => {
  const relay = createMockRelay();
  // The project's own record is recent (the list of every project is cut at its newest records too).
  seedProject(relay, now() - 3600);
  // Set long ago, behind more records than a read can walk past.
  seedGoal(relay, now() - 90 * DAY, { text: "An old goal" });
  seedUpdate(relay, now() - 80 * DAY, "An old week", ["An old promise"]);
  // A full page of the founder's own records in one second cannot be paged past by time, so the read of the founder's
  // records stops there and says so.
  for (let i = 0; i < 500; i += 1)
    relay.seed(
      event(
        47003,
        FOUNDER,
        { title: "Note", body: "" },
        [["a", COORD]],
        now() - 20 * DAY,
      ),
    );
  const first = seedUpdate(relay, now() - 14 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  seedUpdate(
    relay,
    now() - 7 * DAY,
    "Week two",
    [],
    [["promise-mark", `${first.id}:0`, "not-done", "late"]],
  );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-totals-unknown")).toContainText(
    "its totals can't be worked out",
    { timeout: 30_000 },
  );
  // What was read is shown as it stands: the miss is there.
  await expect(record.getByTestId("record-line")).toContainText("Missed");
  await expect(record.getByTestId("record-totals")).toHaveCount(0);
  await expect(record.getByRole("button", { name: "Try again" })).toBeVisible();
  // The goal was set before the cut: the page does not claim there is none.
  await expect(page.getByTestId("goal-unknown")).toContainText(
    "its goal can't be shown",
  );
  await expect(page.getByTestId("goal-missing")).toHaveCount(0);
});

test("other people's records about a project cannot hide its goal or its totals, however many they post", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, now() - 3600);
  seedGoal(relay, now() - 90 * DAY, { text: "An old goal" });
  const first = seedUpdate(relay, now() - 80 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  seedUpdate(
    relay,
    now() - 70 * DAY,
    "Week two",
    [],
    [["promise-mark", `${first.id}:0`, "not-done", "late"]],
  );
  // A stranger posts a page of records naming the project, all newer and all in one second: the read of everyone's
  // records cannot get past them. The founder's own records are read by author, so they are all still read.
  for (let i = 0; i < 500; i += 1)
    relay.seed(
      event(
        47003,
        VISITOR,
        { title: "Offer to help", body: "" },
        [
          ["a", COORD],
          ["help-offer", "f".repeat(64)],
        ],
        now() - 20 * DAY,
      ),
    );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("goal-text")).toHaveText("An old goal", {
    timeout: 30_000,
  });
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "0 kept, 1 missed, 0 changed",
  );
  await expect(record.getByTestId("record-totals-unknown")).toHaveCount(0);
  await expect(page.getByTestId("goal-unknown")).toHaveCount(0);
});

test("an older project that has dropped out of the list of every project still opens by its link", async ({
  page,
}) => {
  const relay = createMockRelay();
  // Sixty days old, with more than a list's worth of newer launchpad records from other projects on the server.
  seedProject(relay);
  seedGoal(relay, now() - 50 * DAY, { text: "A first version ten people use" });
  const elsewhere = `37001:${VISITOR}:other`;
  for (let i = 0; i < 520; i += 1)
    relay.seed(
      event(
        47003,
        VISITOR,
        { title: "Elsewhere", body: "" },
        [["a", elsewhere]],
        now() - 3600 - i,
      ),
    );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nebula");
  await expect(page.getByTestId("goal-text")).toHaveText(
    "A first version ten people use",
  );
  // A link to a project the server does not have still says so.
  await page.goto(`/launchpad/no-such-project?author=${FOUNDER}`);
  await expect(page.getByText("This project wasn't found.")).toBeVisible();
});

test("a new project never takes the id of an older one of the founder's that the list no longer holds", async ({
  page,
}) => {
  const relay = createMockRelay();
  // The founder's own older project "nebula", pushed out of the list of every project by newer records.
  seedProject(relay);
  const elsewhere = `37001:${VISITOR}:other`;
  for (let i = 0; i < 520; i += 1)
    relay.seed(
      event(
        47003,
        VISITOR,
        { title: "Elsewhere", body: "" },
        [["a", elsewhere]],
        now() - 3600 - i,
      ),
    );
  await install(page, relay, FOUNDER_KEY);
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill("Nebula");
  await form
    .getByLabel("What is it, in one sentence?")
    .fill("A second project with the same name.");
  await form.getByLabel("The goal").fill("Something else entirely");
  await form.getByLabel("How we'll know").fill("It is plain to see");
  await form.getByRole("button", { name: "Start the project" }).click();
  // A new id of its own: the older project's record is still there, unchanged.
  await expect(page).toHaveURL(/\/launchpad\/nebula-[0-9a-z]{4}\?/);
  const mine = records(relay, 37001);
  expect(mine).toHaveLength(2);
  expect(mine.map((e) => e.tags.find((t) => t[0] === "d")?.[1]).sort()[0]).toBe(
    "nebula",
  );
  expect(
    JSON.parse(
      mine.find((e) => e.tags.some((t) => t[0] === "d" && t[1] === "nebula"))
        ?.content ?? "{}",
    ).pitch,
  ).toBe("A map of the night sky for everyone.");
});

test("when the founder's own projects can't be read, nothing is started", async ({
  page,
}) => {
  const relay = createMockRelay();
  let failing = true;
  // Only the read of the founder's own project records is dropped.
  relay.setClosingSockets(
    (filter) =>
      failing &&
      Array.isArray(filter?.kinds) &&
      (filter.kinds as number[]).includes(37001) &&
      Array.isArray(filter?.authors) &&
      !Array.isArray(filter?.["#d"]),
  );
  await install(page, relay, FOUNDER_KEY);
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  const failed = form.getByTestId("quick-lists-failed");
  await expect(failed).toContainText("Couldn't check your earlier projects", {
    timeout: 60_000,
  });
  await expect(
    form.getByRole("button", { name: "Start the project" }),
  ).toBeDisabled();
  expect(records(relay, 37001)).toHaveLength(0);
  failing = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(
    form.getByRole("button", { name: "Start the project" }),
  ).toBeEnabled({ timeout: 30_000 });
});

test("a record the founder removed leaves a trace: the count of removals, and an answer left without its promise", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedProject(relay);
  const first = seedUpdate(relay, now() - 14 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  seedUpdate(
    relay,
    now() - 7 * DAY,
    "Week two",
    [],
    [["promise-mark", `${first.id}:0`, "not-done", "late"]],
  );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "0 kept, 1 missed, 0 changed",
  );
  await expect(record.getByTestId("record-removed")).toHaveCount(0);

  // The founder deletes the update that made the promise: the server stops serving it.
  const at = now() - DAY;
  relay.events.splice(
    relay.events.findIndex((e) => e.id === first.id),
    1,
  );
  relay.seed(
    event(
      5,
      FOUNDER,
      "",
      [
        ["e", first.id],
        ["k", "47003"],
      ],
      at,
    ),
  );
  await page.reload();
  // The miss is no longer counted, and the page does not pretend nothing happened.
  await expect(record.getByTestId("record-removed")).toContainText(
    `The founder has removed 1 update record. The last removal was on ${new Date(at * 1000).toLocaleDateString()}.`,
  );
  const line = record.getByTestId("record-line");
  await expect(line).toContainText("Promise removed");
  await expect(line).toContainText('Answered "Not done" (late)');
  await expect(record.getByTestId("record-promise-totals")).toHaveCount(0);
});

test("unrelated deletions cannot hide a removed update, a removal that names no kind is said, and a cut read is not 'none'", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedUpdate(relay, now() - 7 * DAY, "Week one", ["Ship sign-up"]);
  // An old removal of an update record, then more than a page of newer deletions of other things (posts).
  relay.seed(
    event(
      5,
      FOUNDER,
      "",
      [
        ["e", "a".repeat(64)],
        ["k", "47003"],
      ],
      now() - 30 * DAY,
    ),
  );
  // And one that does not say what kind of record it removed: the server takes those too.
  relay.seed(event(5, FOUNDER, "", [["e", "b".repeat(64)]], now() - 29 * DAY));
  for (let i = 0; i < 520; i += 1)
    relay.seed(
      event(
        5,
        FOUNDER,
        "",
        [
          ["e", (1000 + i).toString(16).padStart(64, "c")],
          ["k", "1"],
        ],
        now() - DAY - i,
      ),
    );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  const removed = page
    .getByTestId("project-record")
    .getByTestId("record-removed");
  await expect(removed).toContainText(
    // The 520 removals that say they removed posts are counted too, apart: what a removal says it removes is its
    // signer's word, and one of them may have taken an update away.
    "The founder has removed 1 update record, and 521 other records not marked as updates (a removal can say any kind).",
    { timeout: 30_000 },
  );

  // A founder whose deletions cannot all be read (a full page in one second cannot be walked past), with no update
  // removal among those read: the page does not say there were none.
  const other = createMockRelay();
  seedProject(other);
  seedUpdate(other, now() - 7 * DAY, "Week one", ["Ship sign-up"]);
  for (let i = 0; i < 500; i += 1)
    other.seed(
      event(
        5,
        FOUNDER,
        "",
        // Removals of whole projects: they name a project, not a record, and are not counted as removed records.
        [
          ["a", `37001:${FOUNDER}:old-${i}`],
          ["k", "37001"],
        ],
        now() - DAY,
      ),
    );
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await install(page, other, VISITOR_KEY);
  await page.goto(PROJECT);
  await expect(removed).toContainText(
    "Whether the founder has removed update records could not be checked",
    { timeout: 30_000 },
  );
});

test("a Start whose publish landed but whose answer was lost carries on with that project, not a second one", async ({
  page,
}) => {
  const relay = createMockRelay();
  // The earlier press: its record is on the server, and this browser remembers the id it tried, but never heard back.
  seedProject(relay, now() - 60);
  await install(page, relay, FOUNDER_KEY);
  await page.addInitScript(
    ([founder]) => {
      sessionStorage.setItem(
        "creaton.start.quick.attempt",
        JSON.stringify({ id: "nebula", author: founder }),
      );
      sessionStorage.setItem(
        "creaton.start.quick",
        JSON.stringify({
          name: "Nebula",
          pitch: "A map of the night sky for everyone.",
          goal: "A first version ten people use",
          how: "Ten people sign in in a week",
        }),
      );
    },
    [FOUNDER],
  );
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  await expect(form.getByLabel("Project name")).toHaveValue("Nebula");
  await form.getByRole("button", { name: "Start the project" }).click();
  await expect(page).toHaveURL(/\/launchpad\/nebula\?/);
  await expect(page.getByTestId("goal-text")).toHaveText(
    "A first version ten people use",
  );
  // One project, with its goal: no "nebula-xxxx" beside it.
  expect(records(relay, 37001)).toHaveLength(1);
  expect(tagged(relay, "goal")).toHaveLength(1);
  expect(tagsNamed(tagged(relay, "goal")[0], "a")).toEqual([["a", COORD]]);
});

test("a link that names no author, to an id two people use, asks which project instead of showing one of them", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  // Someone else's project with the same id, and newer.
  relay.seed(
    event(
      37001,
      VISITOR,
      { pitch: "Another Nebula entirely.", stage: "draft" },
      [
        ["d", "nebula"],
        ["name", "Other Nebula"],
        ["t", "dao-launchpad"],
      ],
      now() - DAY,
    ),
  );
  relay.seed(event(0, FOUNDER, { name: "Fay Founder" }, [], now() - 9 * DAY));
  relay.seed(event(0, VISITOR, { name: "Vic Visitor" }, [], now() - 9 * DAY));
  await install(page, relay, VISITOR_KEY);
  await page.goto("/launchpad/nebula");
  const choice = page.getByTestId("launch-choice");
  await expect(choice).toContainText("Which project?");
  await expect(page.getByTestId("launch-hero")).toHaveCount(0);
  await choice
    .getByRole("link", { name: "The project by Fay Founder" })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nebula");
  const hero = page.getByTestId("launch-hero");
  await expect(hero).toContainText("A map of the night sky for everyone.");
  // With the author in the link there is nothing to ask.
  await page.goto(`/launchpad/nebula?author=${VISITOR}`);
  await expect(hero).toContainText("Another Nebula entirely.");
  await expect(page.getByTestId("launch-choice")).toHaveCount(0);
});

test("the Updates tab states no number when its read was cut short", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  // More posts marked as this project's updates than one read returns.
  for (let i = 0; i < 200; i += 1)
    relay.seed(
      event(
        1,
        FOUNDER,
        `Marked post ${i}`,
        [
          ["a", COORD],
          ["l", "launch-update", "creaton.launch"],
        ],
        now() - 3600 - i,
      ),
    );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("latest-update")).toBeVisible();
  const tab = page.getByRole("tab", { name: /^Updates/ });
  await expect(tab).toHaveText("Updates");
});

test("setting up Shares for one project never brings back what was typed for another", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.addInitScript(
    ([founder]) => {
      const server = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
      // A form half filled earlier for a new project "Foo"...
      localStorage.setItem(
        `buzz.start.contributor-form:${server}|${founder}|new`,
        JSON.stringify({
          name: "Foo",
          pitch: "Foo's own sentence, typed weeks ago.",
          symbol: "FOO",
          founderShares: "100000",
          budgetShares: "100000",
          projectCap: "25000",
          reviewers: "",
          quorum: "",
          projects: [{ name: "docs", check: "merged", shares: "25000" }],
        }),
      );
      // ...and now "Set up Shares" pressed on the project Bar.
      if (!sessionStorage.getItem("e2e.handed"))
        localStorage.setItem(
          "creaton.start.from-idea",
          JSON.stringify({
            id: "nebula",
            author: founder,
            name: "Nebula",
            pitch: "A map of the night sky for everyone.",
            server,
          }),
        );
      sessionStorage.setItem("e2e.handed", "1");
    },
    [FOUNDER],
  );
  await page.goto("/start/contributor");
  await expect(page.getByTestId("contributor-carry-on")).toContainText(
    "You are setting up Shares for Nebula.",
  );
  // The form under that line is Nebula's, not Foo's.
  await expect(page.getByLabel("Project name")).toHaveValue("Nebula");
  await expect(page.getByLabel("What it is")).toHaveValue(
    "A map of the night sky for everyone.",
  );
  // Nothing typed yet is not "what you typed before".
  await expect(page.getByTestId("contributor-form-restored")).toHaveCount(0);
  // A reload still carries on the same project.
  await page.getByLabel("Project name").fill("Nebula Two");
  await page.reload();
  await expect(page.getByTestId("contributor-carry-on")).toContainText(
    "Nebula",
  );
  await expect(page.getByLabel("Project name")).toHaveValue("Nebula Two");
  // Start over keeps the project the line names.
  await page.getByTestId("contributor-form-start-over").click();
  await expect(page.getByLabel("Project name")).toHaveValue("Nebula");
  // A separate project: the line goes, and Foo's kept form comes back as a new project's.
  await page.getByTestId("contributor-separate").click();
  await expect(page.getByTestId("contributor-carry-on")).toHaveCount(0);
  await expect(page.getByLabel("Project name")).toHaveValue("Foo");
});

test("answers that disagree are both shown and the worse one is counted; a note that is not an update changes nothing", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  const first = seedUpdate(relay, now() - 21 * DAY, "Week one", [
    "Ship sign-up",
    "Write the guide",
  ]);
  seedUpdate(
    relay,
    now() - 14 * DAY,
    "Week two",
    [],
    [["promise-mark", `${first.id}:0`, "not-done", "late"]],
  );
  // Dated EARLIER than the miss, saying done: a date the signer picks does not decide which answer counts.
  seedUpdate(
    relay,
    now() - 15 * DAY,
    "Week two, again",
    [],
    [["promise-mark", `${first.id}:0`, "done", ""]],
  );
  const later = seedUpdate(relay, now() - 7 * DAY, "Week three", [
    "Invite ten people",
  ]);
  // A record of the same kind the founder signs for another reason (a review note): not an update.
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Turned down", body: "Not this time." },
      [["a", COORD]],
      now() - DAY,
    ),
  );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  const lines = record.getByTestId("record-line");
  const disputed = lines.filter({ hasText: "Ship sign-up" });
  await expect(disputed).toContainText("Missed");
  await expect(disputed).toContainText("Answered more than once");
  await expect(disputed).toContainText("Not done on");
  await expect(disputed).toContainText("Done on");
  await expect(disputed).toContainText("The worse answer is counted");
  // "Write the guide" was passed over by a later weekly update; "Invite ten people" is still for the next one, and the
  // review note after it did not turn it into "not answered".
  await expect(record.getByTestId("record-promise-totals")).toHaveText(
    "0 kept, 1 missed, 0 changed, 1 not answered",
  );
  await expect(lines.filter({ hasText: "Invite ten people" })).toContainText(
    "For the next update",
  );
  expect(later.id).toBeTruthy();
});

test("an answer can be taken back before publishing, and the dialog says it cannot be changed after", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  const first = seedUpdate(relay, now() - 7 * DAY, "Week one", [
    "Ship sign-up",
  ]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByRole("button", { name: "Post update" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-due")).toContainText(
    "an answer can't be changed after you publish",
  );
  const group = dialog.getByRole("group", { name: "Ship sign-up" });
  // It starts on no answer; a tapped answer can be put back.
  await expect(
    group.getByRole("radio", { name: "Not answering yet" }),
  ).toBeChecked();
  await group.getByRole("radio", { name: "Not done" }).check();
  await group.getByRole("radio", { name: "Not answering yet" }).check();
  await expect(dialog.getByLabel("Short note for: Ship sign-up")).toHaveCount(
    0,
  );
  await dialog.getByLabel("Title").fill("Week two");
  await dialog.getByLabel("What happened this week").fill("Still on it.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  // Nothing was answered: no answer tag was written, and the promise now reads as not answered.
  expect(tagged(relay, "promise-mark")).toHaveLength(0);
  await expect(
    page.getByTestId("project-record").getByTestId("record-line"),
  ).toContainText("Not answered");
  expect(first.id).toBeTruthy();
});

test("the card never links to an Updates tab that is not there: posts marked as updates count, and the tab lists them", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  // Two updates in the other form an update takes: the founder's own posts, marked as this project's updates.
  for (const [i, words] of [
    "First marked post",
    "Second marked post",
  ].entries())
    relay.seed(
      event(
        1,
        FOUNDER,
        words,
        [
          ["a", COORD],
          ["l", "launch-update", "creaton.launch"],
        ],
        now() - (2 - i) * DAY,
      ),
    );
  await install(page, relay, VISITOR_KEY);
  await page.goto(PROJECT);
  const card = page.getByTestId("project-update-card");
  await expect(card.getByTestId("latest-update")).toContainText(
    "Second marked post",
  );
  const tab = page.getByRole("tab", { name: "Updates (2)" });
  await expect(tab).toBeVisible();
  await card.getByRole("button", { name: "See all updates" }).click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("First marked post")).toBeVisible();
  await expect(page.getByText("Second marked post")).toBeVisible();
  // And by its link.
  await page.goto(`${PROJECT}&tab=updates`);
  await expect(page.getByRole("tab", { name: "Updates (2)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a problem with an answer is said beside it, and the keyboard goes to that answer", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill("Comet");
  await form
    .getByLabel("What is it, in one sentence?")
    .fill("A tiny telescope anyone can build.");
  await form.getByRole("button", { name: "Start the project" }).click();
  const goalField = form.getByLabel("The goal");
  await expect(goalField).toBeFocused();
  await expect(goalField).toHaveAttribute("aria-invalid", "true");
  await expect(goalField).toHaveAccessibleDescription("Say what the goal is.");

  await page.goto(PROJECT);
  await page.getByRole("button", { name: "Set your goal" }).click();
  const dialog = page.getByRole("dialog", { name: "Set your goal" });
  await dialog.getByLabel("The goal").fill("Reach a hundred readers");
  await dialog.getByRole("button", { name: "Save goal" }).click();
  const how = dialog.getByLabel("How we'll know");
  await expect(how).toBeFocused();
  await expect(how).toHaveAccessibleDescription(
    "Say how we'll know it was reached.",
  );
});

test("at 390px Start, the project page and its dialogs fit with no sideways scroll", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  const long = "a-very-long-unbroken-word-".repeat(6);
  seedGoal(relay, now() - 30 * DAY, {
    text: `Goal-${long}`,
    how: `How-${long}`,
  });
  seedGoal(relay, now() - 20 * DAY, {
    text: `Goal-${long}`,
    how: `How-${long}`,
    state: "missed",
    reason: `Why-${long}`,
  });
  seedGoal(relay, now() - 10 * DAY, {
    id: "w1",
    level: "week",
    text: `Week-${long}`,
  });
  const first = seedUpdate(relay, now() - 14 * DAY, "Week one", [
    `Promise-${long}`,
    "Write the guide",
  ]);
  seedUpdate(
    relay,
    now() - 7 * DAY,
    "Week two",
    [`Next-${long}`],
    [
      ["promise-mark", `${first.id}:0`, "not-done", `note-${long}`],
      ["promise-mark", `${first.id}:1`, "done", ""],
    ],
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, relay, FOUNDER_KEY);

  await page.goto("/start");
  await expect(page.getByTestId("quick-start")).toBeVisible();
  await page.getByText("More ways to start").click();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "start, phone");

  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-line").first()).toBeVisible();
  await page.getByTestId("goal-history").first().locator("summary").click();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "project page with goal and record, phone");

  await page.getByRole("button", { name: "Update this goal" }).click();
  await expect(
    page.getByRole("dialog", { name: "Update this goal" }),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Post update" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-due-promise")).toHaveCount(1);
  expect(await noSidewaysScroll(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
});
