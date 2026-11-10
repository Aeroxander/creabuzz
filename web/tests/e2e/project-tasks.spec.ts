import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { COMMUNITY_HOST, createMockRelay, matches } from "./mock-relay";

/**
 * Tasks with a finish line, as one loop on one server across three people: the founder accepts an offer and writes
 * what "done" means, the helper hands work in, a second team member sends it back, the helper hands it in again, and
 * the founder confirms it. Then the helper's profile shows the work accepted. Around it: who may never confirm, a
 * task given directly, a send whose answer was lost, what a visitor without an account sees, reads cut short, and a
 * phone-width screen.
 *
 * One mock server holds every record; a person is swapped by changing whose key the page has and loading again, so
 * what each sees is read back from the server, never from another's page memory.
 */

const FOUNDER_KEY = "4".repeat(64);
const HELPER_KEY = "5".repeat(64);
const MATE_KEY = "6".repeat(64);
const pubkeyOf = (key: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(key, "hex")));
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const HELPER = pubkeyOf(HELPER_KEY);
const MATE = pubkeyOf(MATE_KEY);
const COORD = `37001:${FOUNDER}:nebula-os`;
const PROJECT = `/launchpad/nebula-os?author=${FOUNDER}`;
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const ASK = "Someone to test sign-up on an older phone.";
const DONE = "A screen recording of sign-up working on Android 9.";

type Relay = ReturnType<typeof createMockRelay>;
type Stored = Relay["events"][number];

let sequence = 0;
function event(
  kind: number,
  pubkey: string,
  content: unknown,
  tags: string[][],
  at: number,
): Stored {
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

/** A project, its people's names, an update that asks for help, and (unless told not to) the helper's offer. */
function seedProject(
  relay: Relay,
  { mate = true, offer = true }: { mate?: boolean; offer?: boolean } = {},
) {
  relay.seed(
    event(
      37001,
      FOUNDER,
      { pitch: "Build a useful app together.", stage: "draft" },
      [
        ["d", "nebula-os"],
        ["name", "Nebula OS"],
        ["t", "dao-launchpad"],
        ["team", FOUNDER, "Founder"],
        ...(mate ? [["team", MATE, "Reviewer"]] : []),
      ],
      now() - 60 * DAY,
    ),
  );
  relay.seed(event(0, FOUNDER, { name: "Fay Founder" }, [], now() - 60 * DAY));
  relay.seed(event(0, HELPER, { name: "Robin Helper" }, [], now() - 60 * DAY));
  relay.seed(event(0, MATE, { name: "Max Mate" }, [], now() - 60 * DAY));
  const update = event(
    47003,
    FOUNDER,
    { title: "Week one", body: `Help needed (Small)\n${ASK}` },
    [
      ["a", COORD],
      ["update-kind", "weekly"],
      ["help-needed", ASK],
      ["help-size", "small"],
    ],
    now() - 2 * DAY,
  );
  relay.seed(update);
  const offered = event(
    47003,
    HELPER,
    { title: "Offer to help", body: "I have an old phone." },
    [
      ["a", COORD],
      ["e", update.id],
      ["p", FOUNDER],
      ["help-offer", update.id],
    ],
    now() - DAY,
  );
  if (offer) relay.seed(offered);
  return { update, offer: offered };
}

/** A task record as the app writes it, seeded straight into the server. */
function seedTask(
  relay: Relay,
  {
    by = FOUNDER,
    helper = HELPER,
    what = ASK,
    due,
    offerId,
    at = now() - 3600,
  }: {
    by?: string;
    helper?: string;
    what?: string;
    due?: string;
    offerId?: string;
    at?: number;
  } = {},
) {
  const task = event(
    47003,
    by,
    { title: "Task", body: what },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", helper],
      ["task-helper", helper],
      ["task-what", what],
      ["task-done", DONE],
      ["task-size", "small"],
      ...(due ? [["task-due", due]] : []),
      ...(offerId ? [["task-offer", offerId]] : []),
    ],
    at,
  );
  relay.seed(task);
  return task;
}

/** A later step on a task, seeded. */
function seedStep(
  relay: Relay,
  by: string,
  task: Stored,
  part: string,
  extra: string[][] = [],
  note = "",
  at = now() - 600,
) {
  const step = event(
    47003,
    by,
    { title: part, body: note, ...(note ? { note } : {}) },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", part],
      ["e", task.id],
      ["task", task.id],
      // As the app writes it: a team member's step names the helper, a helper's step names the team.
      ...(by === HELPER
        ? [
            ["p", FOUNDER],
            ["p", MATE],
          ]
        : [["p", HELPER]]),
      ...extra,
    ],
    at,
  );
  relay.seed(step);
  return step;
}

async function install(page: Page, relay: Relay, key: string | null) {
  await relay.install(page);
  // Whose page this is: the key under `e2e.key` wins, so a test can become someone else and load again.
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

const parts = (relay: Relay, part: string) =>
  relay.events.filter((e) =>
    e.tags.some((t) => t[0] === "task-part" && t[1] === part),
  );
const tag = (e: Stored, name: string) => e.tags.find((t) => t[0] === name)?.[1];
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("an offer becomes a task with a finish line; the helper hands in, it is sent back, handed in again and confirmed by someone else; the profile shows it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  const seeded = seedProject(relay);
  await install(page, relay, FOUNDER_KEY);

  // The founder accepts the offer. "Done means" is required before the task exists.
  await page.goto(PROJECT);
  const offer = page
    .getByTestId("project-update-card")
    .getByTestId("help-offer");
  await offer
    .getByRole("button", {
      name: "Accept Robin Helper's offer and make a task",
    })
    .click();
  const form = offer.getByRole("form", {
    name: "Make a task for Robin Helper",
  });
  await expect(form.getByTestId("offer-task-form-what")).toContainText(ASK);
  await expect(form.getByLabel("Done means")).toBeFocused();
  await expect(form.getByTestId("task-rewards-line")).toContainText(
    "Rewards are decided separately, by the project's own rules.",
  );
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(form.getByTestId("offer-task-form-problem")).toHaveText(
    "Say what finished looks like, so the work can be checked.",
  );
  expect(parts(relay, "task")).toHaveLength(0);
  await form.getByLabel("Done means").fill(DONE);
  await form.getByLabel("Due date (optional)").fill("2099-01-15");
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(offer.getByTestId("offer-task-made")).toContainText(
    "Task made. Robin Helper is told.",
  );

  // One team-signed record, its fields as tags, and no amount anywhere in it.
  await expect.poll(() => parts(relay, "task").length).toBe(1);
  const task = parts(relay, "task")[0];
  expect(task.pubkey).toBe(FOUNDER);
  expect(task.tags).toEqual(
    expect.arrayContaining([
      ["a", COORD],
      ["l", "creaton-task"],
      ["p", HELPER],
      ["task-helper", HELPER],
      ["task-what", ASK],
      ["task-done", DONE],
      ["task-size", "small"],
      ["task-due", "2099-01-15"],
      ["task-update", seeded.update.id],
      ["task-offer", seeded.offer.id],
    ]),
  );
  expect(JSON.stringify(task)).not.toMatch(/Shares|\$|earn/i);

  // The project page lists it: who, what, done means, state, due.
  const tasks = page.getByTestId("project-tasks");
  const row = tasks.getByTestId("task");
  await expect(row).toHaveAttribute("data-state", "in-progress");
  await expect(row.getByTestId("task-state")).toHaveText("In progress");
  await expect(row).toContainText(ASK);
  await expect(row.getByTestId("task-done-means")).toContainText(DONE);
  await expect(row.getByTestId("task-who")).toContainText("With Robin Helper");
  await expect(row.getByTestId("task-due")).toContainText("Due ");
  await expect(tasks).not.toContainText(/Shares|\$|earn/i);

  // The helper is told, and the notice opens the task.
  await openAs(page, HELPER_KEY, "/social/notifications");
  const notice = page.getByTestId("social-task-notice");
  await expect(notice).toContainText(
    "Fay Founder accepted your offer and made it a task:",
  );
  await expect(notice).toContainText("in Nebula OS");
  await notice.getByRole("link").click();
  await expect(row).toHaveAttribute("data-state", "in-progress");
  // The helper is never offered a confirmation of their own work.
  await expect(
    row.getByRole("button", { name: "Confirm it's done" }),
  ).toHaveCount(0);

  // Hand in: something has to be handed in, and a line that is not a link is said.
  await row.getByRole("button", { name: "Hand in work" }).click();
  const handIn = row.getByRole("form", { name: "Hand in work" });
  await handIn.getByRole("button", { name: "Hand in" }).click();
  await expect(handIn.getByTestId("task-hand-in-box-problem")).toHaveText(
    "Add what you did: a few words, a link, or a file.",
  );
  await handIn.getByLabel("What you did").fill("Tested on a Moto G6.");
  await handIn.getByLabel("Links (optional, one per line)").fill("not-a-link");
  await handIn.getByRole("button", { name: "Hand in" }).click();
  await expect(handIn.getByTestId("task-hand-in-box-problem")).toContainText(
    "This is not a web link: not-a-link",
  );
  await handIn
    .getByLabel("Links (optional, one per line)")
    .fill("https://example.org/first-try");
  await handIn.getByRole("button", { name: "Hand in" }).click();
  await expect(tasks.getByTestId("tasks-said")).toHaveText(
    "Your work is handed in. The team is told.",
  );
  await expect(row).toHaveAttribute("data-state", "submitted");
  await expect.poll(() => parts(relay, "evidence").length).toBe(1);
  const first = parts(relay, "evidence")[0];
  expect(first.pubkey).toBe(HELPER);
  expect(first.tags).toEqual(
    expect.arrayContaining([
      ["e", task.id],
      ["task", task.id],
      ["p", FOUNDER],
      ["p", MATE],
      ["task-link", "https://example.org/first-try"],
    ]),
  );

  // A confirmation the helper signs themselves, straight to the server, changes nothing and is called out.
  seedStep(relay, HELPER, task, "confirm", [["task-evidence", first.id]]);
  await page.reload();
  await expect(row).toHaveAttribute("data-state", "submitted");
  await expect(row.getByTestId("task-confirm-ignored")).toBeVisible();
  // With work waiting for a check, the one who did it is still offered no way to confirm it.
  await expect(
    row.getByRole("button", { name: /Confirm|Send back/ }),
  ).toHaveCount(0);
  await expect(page.getByTestId("record-work-accepted")).toHaveCount(0);

  // The second team member is told, and sends the work back with a reason.
  await openAs(page, MATE_KEY, "/social/notifications");
  await expect(
    page.getByTestId("social-task-notice").filter({ hasText: "handed in" }),
  ).toContainText("Robin Helper handed in work for you to check on:");
  await page.goto(PROJECT);
  await expect(row.getByTestId("task-evidence")).toContainText(
    "Tested on a Moto G6.",
  );
  await expect(
    row.getByRole("link", { name: "https://example.org/first-try" }),
  ).toHaveAttribute("rel", /nofollow/);
  await row.getByRole("button", { name: "Send back" }).click();
  const back = row.getByRole("form", { name: "Send the work back" });
  await back.getByRole("button", { name: "Send back" }).click();
  await expect(back.getByTestId("task-send-back-box-problem")).toHaveText(
    "Say what is missing, so the work can be finished.",
  );
  expect(parts(relay, "send-back")).toHaveLength(0);
  await back.getByLabel("What is missing").fill("There is no recording.");
  // Sent from the keyboard.
  await back.getByLabel("What is missing").press("Tab");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-state", "sent-back");
  await expect(row.getByTestId("task-sent-back-reason")).toContainText(
    "There is no recording.",
  );
  expect(tag(parts(relay, "send-back")[0], "task-evidence")).toBe(first.id);

  // The helper sees why, and hands in again.
  await openAs(page, HELPER_KEY, "/social/notifications");
  await expect(
    page.getByTestId("social-task-notice").filter({ hasText: "sent your" }),
  ).toContainText("Max Mate sent your work back on:");
  await page.goto(PROJECT);
  await expect(row.getByTestId("task-sent-back-reason")).toContainText(
    "Sent back by Max Mate",
  );
  await row.getByRole("button", { name: "Hand in again" }).click();
  const again = row.getByRole("form", { name: "Hand in work" });
  await again.getByLabel("What you did").fill("Recorded it this time.");
  await again
    .getByLabel("Links (optional, one per line)")
    .fill("https://example.org/recording");
  await again.getByRole("button", { name: "Hand in" }).click();
  await expect(row).toHaveAttribute("data-state", "submitted");
  await expect.poll(() => parts(relay, "evidence").length).toBe(2);
  const second = parts(relay, "evidence").find((e) => e.id !== first.id);

  // The founder confirms the second piece. The rewards line is said there, once.
  await openAs(page, FOUNDER_KEY, PROJECT);
  await row.getByRole("button", { name: "Confirm it's done" }).click();
  const confirm = row.getByTestId("task-confirm-box");
  await expect(confirm.getByTestId("task-rewards-line")).toHaveText(
    "Rewards are decided separately, by the project's own rules.",
  );
  await confirm.getByRole("button", { name: "Yes, confirm" }).click();
  await expect(tasks.getByTestId("tasks-said")).toHaveText(
    "You confirmed this work.",
  );
  const confirms = () =>
    parts(relay, "confirm").filter((e) => e.pubkey === FOUNDER);
  await expect.poll(() => confirms().length).toBe(1);
  expect(tag(confirms()[0], "task-evidence")).toBe(second?.id);
  expect(JSON.stringify(confirms()[0])).not.toMatch(/Shares|\$|earn/i);

  // It leaves the open list and shows on the record as work accepted, with the evidence that was accepted.
  await expect(tasks.getByTestId("task")).toHaveCount(0);
  const record = page.getByTestId("project-record");
  const accepted = record.getByTestId("record-work-accepted");
  await expect(accepted).toContainText("Work accepted");
  await expect(accepted).toContainText(ASK);
  await expect(accepted).toContainText(
    "Done by Robin Helper, checked by Fay Founder",
  );
  await expect(
    accepted.getByRole("link", { name: "https://example.org/recording" }),
  ).toBeVisible();
  await expect(accepted).not.toContainText("first-try");
  await expect(record.getByTestId("record-work-totals")).toHaveText(
    "1 piece of work accepted",
  );
  await expect(record).not.toContainText(/Shares|\$|earn/i);
  await expectAccessible(page, "project page with accepted work");

  // The helper is told, and their profile shows the work with its project and evidence.
  await openAs(page, HELPER_KEY, "/social/notifications");
  await expect(
    page.getByTestId("social-task-notice").filter({ hasText: "confirmed" }),
  ).toContainText("Fay Founder confirmed your work on:");
  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  const track = page.getByTestId("track-record");
  await expect(track.getByTestId("track-record-accepted")).toHaveText(
    "1 piece of work accepted",
  );
  await expect(track.getByTestId("track-record-misses")).toHaveText(
    "1 task sent back at least once, 0 given up",
  );
  const item = track.getByTestId("track-work-item");
  await expect(item).toContainText(ASK);
  await expect(item).toContainText("confirmed by Fay Founder");
  await expect(item.getByRole("link", { name: "Nebula OS" })).toHaveAttribute(
    "href",
    new RegExp(`/launchpad/nebula-os\\?author=${FOUNDER}`),
  );
  await expect(
    item.getByRole("link", { name: "https://example.org/recording" }),
  ).toBeVisible();
  await expect(track).not.toContainText(/Shares|\$|earn/i);
  await expectAccessible(page, "profile track record");

  // Anyone reading the profile sees the same; the founder's own shows their side, with no work accepted.
  await openAs(page, null, `/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(track.getByTestId("track-record-accepted")).toHaveText(
    "1 piece of work accepted",
  );
  await page.goto(`/u/${FOUNDER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(track.getByTestId("track-record-accepted")).toHaveText(
    "0 pieces of work accepted",
  );
  await expect(track.getByTestId("track-record-founder")).toContainText(
    "1 update posted on 1 project",
  );
});

test("when the founder does the work, someone else must confirm; with nobody else on the team the page says so and offers nothing", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { mate: false, offer: false });
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  await tasks.getByRole("button", { name: "Give someone a task" }).click();
  const form = tasks.getByRole("form", { name: "Give someone a task" });
  // Nobody picked yet.
  await form.getByLabel("What is the task").fill("Write the changelog.");
  await form.getByLabel("Done means").fill("A changelog page is live.");
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(form.getByTestId("direct-task-form-problem")).toHaveText(
    "Pick who the task is for.",
  );
  await form.getByRole("button", { name: "I'll do it myself" }).click();
  await form.getByRole("radio", { name: "Medium" }).check();
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(tasks.getByTestId("tasks-said")).toContainText(
    "Someone else on the team checks it when you hand it in.",
  );
  const row = tasks.getByTestId("task");
  await expect(row).toHaveAttribute("data-state", "in-progress");
  expect(tag(parts(relay, "task")[0], "task-size")).toBe("medium");

  await row.getByRole("button", { name: "Hand in work" }).click();
  const handIn = row.getByRole("form", { name: "Hand in work" });
  await handIn.getByLabel("What you did").fill("It is live.");
  await handIn.getByRole("button", { name: "Hand in" }).click();
  await expect(row).toHaveAttribute("data-state", "submitted");
  await expect(row.getByTestId("task-cannot-confirm")).toHaveText(
    "You did this work, so someone else on the team has to confirm it. Nobody else is on this project's team yet: add a team member to the project before this can be confirmed.",
  );
  await expect(
    row.getByRole("button", { name: /Confirm|Send back|Cancel task/ }),
  ).toHaveCount(0);
  expect(parts(relay, "confirm")).toHaveLength(0);
});

test("with a second team member, the founder's own work waits for them, and they can confirm it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, {
    helper: FOUNDER,
    what: "Write the changelog.",
  });
  seedStep(relay, FOUNDER, task, "evidence", [], "It is live.");
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row.getByTestId("task-cannot-confirm")).toHaveText(
    "You did this work, so someone else on the team has to confirm it.",
  );
  await expect(
    row.getByRole("button", { name: "Confirm it's done" }),
  ).toHaveCount(0);

  await openAs(page, MATE_KEY, PROJECT);
  await row.getByRole("button", { name: "Confirm it's done" }).click();
  await row.getByRole("button", { name: "Yes, confirm" }).click();
  await expect(
    page.getByTestId("project-record").getByTestId("record-work-accepted"),
  ).toContainText("Done by Fay Founder, checked by Max Mate");
});

test("a task given directly names the person only once they say yes", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  await tasks.getByRole("button", { name: "Give someone a task" }).click();
  const form = tasks.getByRole("form", { name: "Give someone a task" });
  await form.getByTestId("direct-task-person").fill(HELPER);
  await form.getByTestId("person-search-result").first().click();
  await expect(form.getByTestId("direct-task-who")).toContainText(
    "For Robin Helper",
  );
  await form.getByLabel("What is the task").fill("Draw the logo.");
  await form.getByLabel("Done means").fill("An SVG the team agrees on.");
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(tasks.getByTestId("tasks-said")).toHaveText(
    "Task made. It is Robin Helper's once they say yes.",
  );
  const row = tasks.getByTestId("task");
  await expect(row).toHaveAttribute("data-state", "offered");

  // A visitor reads the task, without the name of someone who has not agreed. Their profile does not count it.
  await openAs(page, null, PROJECT);
  await expect(row.getByTestId("task-who")).toContainText(
    "Offered to someone who has not said yes yet",
  );
  await expect(row).not.toContainText("Robin Helper");
  await expect(row.getByRole("button")).toHaveCount(0);

  // The person is told and says yes; from then on they are named.
  await openAs(page, HELPER_KEY, "/social/notifications");
  await expect(page.getByTestId("social-task-notice")).toContainText(
    "Fay Founder gave you a task to say yes or no to:",
  );
  await page.goto(PROJECT);
  await expect(row.getByTestId("task-rewards-line")).toHaveText(
    "Rewards are decided separately, by the project's own rules.",
  );
  await row.getByRole("button", { name: "Yes, I'll do it" }).click();
  await expect(row).toHaveAttribute("data-state", "in-progress");
  expect(parts(relay, "accept")[0].pubkey).toBe(HELPER);
  await openAs(page, null, PROJECT);
  await expect(row.getByTestId("task-who")).toContainText("With Robin Helper");
});

test("a task whose answer was lost is carried on by Try again, with the draft kept and one task made", async ({
  page,
}) => {
  let lose = true;
  const relay = createMockRelay({
    loseAnswer: (e) => {
      const isTask = e.tags.some(
        (t) => t[0] === "task-part" && t[1] === "task",
      );
      if (!isTask || !lose) return false;
      lose = false;
      return true;
    },
  });
  seedProject(relay, { offer: false });
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  await tasks.getByRole("button", { name: "Give someone a task" }).click();
  const form = tasks.getByRole("form", { name: "Give someone a task" });
  await form.getByRole("button", { name: "I'll do it myself" }).click();
  await form.getByLabel("What is the task").fill("Write the changelog.");
  await form.getByLabel("Done means").fill("A changelog page is live.");
  await form.getByRole("button", { name: "Make the task" }).click();
  // The server took it and the answer never came: the form says the send failed, with every word still there.
  const failed = form.getByTestId("direct-task-form-failed");
  await expect(failed).toContainText("The task was not made.");
  await expect(form.getByLabel("What is the task")).toHaveValue(
    "Write the changelog.",
  );
  await expect(form.getByLabel("Done means")).toHaveValue(
    "A changelog page is live.",
  );
  expect(parts(relay, "task")).toHaveLength(1);
  // The id that was tried is kept in the browser, so the retry can find out what became of it.
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((k) =>
          k.startsWith("creaton.task-send.v1:"),
        ).length,
    ),
  ).toBe(1);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(tasks.getByTestId("tasks-said")).toContainText("Task made.");
  await expect(form).toHaveCount(0);
  await expect(tasks.getByTestId("task")).toHaveCount(1);
  // One task, not two; and nothing left kept.
  expect(parts(relay, "task")).toHaveLength(1);
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((k) =>
          k.startsWith("creaton.task-send.v1:"),
        ).length,
    ),
  ).toBe(0);
});

test("a send the server refuses keeps what was written, and Try again sends it", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (e) =>
      refuse && e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence")
        ? "blocked: try later"
        : null,
  });
  const seeded = seedProject(relay);
  seedTask(relay, { offerId: seeded.offer.id });
  await install(page, relay, HELPER_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await row.getByRole("button", { name: "Hand in work" }).click();
  const handIn = row.getByRole("form", { name: "Hand in work" });
  await handIn.getByLabel("What you did").fill("Tested on a Moto G6.");
  await handIn.getByRole("button", { name: "Hand in" }).click();
  const failed = handIn.getByTestId("task-hand-in-box-failed");
  await expect(failed).toContainText("Your work was not handed in.");
  await expect(handIn.getByLabel("What you did")).toHaveValue(
    "Tested on a Moto G6.",
  );
  expect(parts(relay, "evidence")).toHaveLength(0);
  refuse = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(row).toHaveAttribute("data-state", "submitted");
  expect(parts(relay, "evidence")).toHaveLength(1);
});

test("signed out: tasks and accepted work can be read, nothing can be changed, and I can help opens sign-up", async ({
  page,
}) => {
  const relay = createMockRelay();
  const seeded = seedProject(relay, { offer: false });
  // One late task in progress, one finished.
  const late = seedTask(relay, {
    due: "2020-01-01",
    what: "Fix the invite email.",
  });
  seedStep(relay, HELPER, late, "accept");
  const done = seedTask(relay, { what: "Draw the logo." });
  const work = seedStep(
    relay,
    HELPER,
    done,
    "evidence",
    [["task-link", "https://example.org/logo"]],
    "Here it is.",
  );
  seedStep(relay, MATE, done, "confirm", [["task-evidence", work.id]]);
  await install(page, relay, null);
  await page.goto(PROJECT);

  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Fix the invite email.");
  // Late shows as late; it is not hidden.
  await expect(row).toHaveAttribute("data-late", "true");
  await expect(row.getByTestId("task-late")).toHaveText("Late");
  await expect(row.getByTestId("task-due")).toContainText("Late: was due");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("give-task")).toHaveCount(0);
  await expect(
    page.getByTestId("project-record").getByTestId("record-work-accepted"),
  ).toContainText("Draw the logo.");

  const request = page
    .getByTestId("project-update-card")
    .getByTestId("help-request");
  await request.getByRole("button", { name: "I can help" }).click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(
    relay.events.filter(
      (e) =>
        e.pubkey !== FOUNDER &&
        e.kind === 47003 &&
        tag(e, "e") === seeded.update.id,
    ),
  ).toHaveLength(0);
});

test("forged steps change nothing: a stranger's task, a stranger's confirmation, and a confirmation of missing work", async ({
  page,
}) => {
  const STRANGER = pubkeyOf("7".repeat(64));
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  // A "task" by someone who is not on the team.
  seedTask(relay, { by: STRANGER, what: "A task nobody on the team made." });
  const real = seedTask(relay, { what: "Fix the invite email." });
  const work = seedStep(relay, HELPER, real, "evidence", [], "Fixed.");
  seedStep(relay, STRANGER, real, "confirm", [["task-evidence", work.id]]);
  seedStep(relay, MATE, real, "confirm", [["task-evidence", "e".repeat(64)]]);
  await install(page, relay, null);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-state", "submitted");
  await expect(row.getByTestId("task-evidence-missing")).toBeVisible();
  await expect(page.getByTestId("record-work-accepted")).toHaveCount(0);
  await expect(page.getByText("A task nobody on the team made.")).toHaveCount(
    0,
  );

  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByTestId("track-record-accepted")).toHaveText(
    "0 pieces of work accepted",
  );
});

test("a confirmation its signer removed is gone from the record, and the page says that team member removed a record", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  const work = seedStep(relay, HELPER, task, "evidence", [], "Fixed.");
  const ok = seedStep(relay, MATE, task, "confirm", [
    ["task-evidence", work.id],
  ]);
  await install(page, relay, null);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-work-accepted")).toContainText(
    "Fix the invite email.",
  );
  await expect(record.getByTestId("record-team-removed")).toHaveCount(0);

  // Max takes the confirmation back by deleting it. The server stops serving it.
  relay.events.splice(
    relay.events.findIndex((e) => e.id === ok.id),
    1,
  );
  relay.seed(
    event(
      5,
      MATE,
      "",
      [
        ["e", ok.id],
        ["k", "47003"],
      ],
      now() - 60,
    ),
  );
  await page.reload();
  await expect(
    page.getByTestId("project-tasks").getByTestId("task"),
  ).toHaveAttribute("data-state", "submitted");
  await expect(record.getByTestId("record-work-accepted")).toHaveCount(0);
  await expect(record.getByTestId("record-team-removed")).toContainText(
    "Max Mate has removed 1 record",
  );
});

test("reads cut short are said, and no numbers are stated from them", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  // More task records in one second than a page holds: the read cannot be walked to its end.
  const at = now() - 100;
  for (let i = 0; i < 500; i += 1)
    relay.seed(
      event(
        47003,
        MATE,
        { title: "more-time", body: "x", note: "x" },
        [
          ["a", COORD],
          ["l", "creaton-task"],
          ["task-part", "grant"],
          ["e", task.id],
          ["task", task.id],
          ["p", HELPER],
          ["task-ask", "9".repeat(64)],
          ["task-due", "2099-01-01"],
        ],
        at,
      ),
    );
  await install(page, relay, null);
  await page.goto(PROJECT);
  await expect(page.getByTestId("tasks-read-cut")).toContainText(
    "a task or a step on one may be missing",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("record-work-cut")).toContainText(
    "how much work it accepted can't be worked out",
  );
  await expect(page.getByTestId("record-work-totals")).toHaveCount(0);

  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  const track = page.getByTestId("track-record");
  await expect(track.getByTestId("track-record-cut")).toContainText(
    "the numbers could not be worked out",
    { timeout: 30_000 },
  );
  await expect(track.getByTestId("track-record-totals")).toHaveCount(0);
});

test("when the tasks can't be read the page says so with Try again, and reads them on retry", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  seedStep(relay, HELPER, task, "accept");
  await install(page, relay, null);
  // Only the read that names the task label is dropped; everything else still answers.
  let failing = true;
  relay.setClosingSockets(
    (filter) =>
      failing &&
      Array.isArray(filter?.["#l"]) &&
      (filter["#l"] as string[]).includes("creaton-task"),
  );
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  await expect(tasks.getByTestId("tasks-read-failed")).toContainText(
    "Couldn't read this project's tasks.",
    { timeout: 60_000 },
  );
  await expect(tasks.getByTestId("task")).toHaveCount(0);
  failing = false;
  await tasks.getByRole("button", { name: "Try again" }).click();
  await expect(tasks.getByTestId("task")).toContainText(
    "Fix the invite email.",
    { timeout: 30_000 },
  );
});

test("at 390px the tasks, the forms and the profile record fit with no sideways scroll", async ({
  page,
}) => {
  const relay = createMockRelay();
  const seeded = seedProject(relay);
  const long = `Test-${"a-very-long-unbroken-word-".repeat(8)}`;
  const task = seedTask(relay, { what: long, offerId: seeded.offer.id });
  const work = seedStep(
    relay,
    HELPER,
    task,
    "evidence",
    [
      ["task-link", `https://example.org/${"x".repeat(200)}`],
      ["task-file", "9".repeat(64), "recording.mp4", "https://example.org/f"],
    ],
    "y".repeat(300),
  );
  const done = seedTask(relay, { what: long });
  const doneWork = seedStep(relay, HELPER, done, "evidence", [
    ["task-link", `https://example.org/${"z".repeat(200)}`],
  ]);
  seedStep(relay, MATE, done, "confirm", [["task-evidence", doneWork.id]]);
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, relay, HELPER_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row.getByTestId("task-evidence")).toBeVisible();
  await row.getByRole("button", { name: "Hand in again" }).click();
  await expect(row.getByRole("form", { name: "Hand in work" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "tasks with the hand-in box, phone");

  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByTestId("track-work-item")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "profile track record, phone");

  // The team's side: confirm and send back, and the form a task is made in.
  await openAs(page, MATE_KEY, PROJECT);
  await row.getByRole("button", { name: "Send back" }).click();
  await expect(
    row.getByRole("form", { name: "Send the work back" }),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.keyboard.press("Escape");
  await page
    .getByTestId("project-tasks")
    .getByRole("button", { name: "Give someone a task" })
    .click();
  await expect(
    page.getByRole("form", { name: "Give someone a task" }),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "give a task form, phone");
  expect(work.id).not.toBe(doneWork.id);
});
