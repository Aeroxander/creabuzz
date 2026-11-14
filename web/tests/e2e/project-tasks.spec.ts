import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import {
  COMMUNITY_HOST,
  createMockRelay,
  deletionRefusal,
  matches,
  projectRecordRefusal,
} from "./mock-relay";

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
    "Task made. It is Robin Helper's once they say yes.",
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
  // An offer to help is not agreement to this task: it waits for Robin's own yes, and until then only the team
  // (and Robin) are shown it.
  await expect(row).toHaveAttribute("data-state", "offered");
  await expect(row.getByTestId("task-state")).toHaveText("Waiting for a yes");
  await expect(row).toContainText(ASK);
  await expect(row.getByTestId("task-done-means")).toContainText(DONE);
  await expect(row.getByTestId("task-who")).toContainText(
    "Given to Robin Helper, who has not said yes",
  );
  await expect(row.getByTestId("task-not-agreed")).toContainText(
    "The task itself is a public record that names them.",
  );
  await expect(row.getByTestId("task-due")).toContainText("Due ");
  await expect(tasks).not.toContainText(/Shares|\$|earn/i);

  // The helper is told, and the notice opens the task.
  await openAs(page, HELPER_KEY, "/social/notifications");
  const notice = page.getByTestId("social-task-notice");
  await expect(notice).toContainText(
    "Fay Founder gave you a task to say yes or no to:",
  );
  await expect(notice).toContainText("in Nebula OS");
  await notice.getByRole("link").click();
  await expect(row).toHaveAttribute("data-state", "offered");
  await expect(row.getByRole("button", { name: "Hand in work" })).toHaveCount(
    0,
  );
  await row.getByRole("button", { name: "Yes, I'll do it" }).click();
  await expect(row).toHaveAttribute("data-state", "in-progress");
  await expect(row.getByTestId("task-who")).toContainText("With Robin Helper");
  expect(parts(relay, "accept")[0].pubkey).toBe(HELPER);
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
    "Done by Robin Helper. Checked by Fay Founder",
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
    "1 piece of work accepted, on 1 project, confirmed by 1 person",
  );
  await expect(track.getByTestId("track-record-how")).toContainText(
    "Anyone can start a project and confirm work on it, so read who confirmed each piece.",
  );
  await expect(track.getByTestId("track-record-misses")).toHaveText(
    "1 task sent back at least once, 0 given up",
  );
  const item = track.getByTestId("track-work-item");
  await expect(item).toContainText(ASK);
  await expect(item).toContainText(
    "confirmed by the project's founder, Fay Founder",
  );
  // Outside work: nothing ties Robin to the project's team.
  await expect(item.getByTestId("track-work-tie")).toHaveCount(0);
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
    "1 piece of work accepted, on 1 project, confirmed by 1 person",
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
  ).toContainText(
    "Done by Fay Founder, who is on this project's team. Checked by Max Mate",
  );
  // On the profile it is visibly not outside work.
  await page.goto(`/u/${FOUNDER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  const item = page.getByTestId("track-work-item");
  await expect(item).toContainText("confirmed by a team member, Max Mate");
  await expect(item.getByTestId("track-work-tie")).toHaveText(
    "They made this task for themselves, and are on this project's team.",
  );
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
  // The form opens with the keyboard on its first control, and says what is public before a name is typed.
  await expect(form.getByTestId("direct-task-person")).toBeFocused();
  await expect(form.getByTestId("direct-task-public")).toHaveText(
    "This page shows the task and their name only once they say yes. The task itself is a public record that names them.",
  );
  // Cancel gives the keyboard back to the button that opened the form.
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  const give = tasks.getByRole("button", { name: "Give someone a task" });
  await expect(give).toBeFocused();
  await give.click();
  await form.getByTestId("direct-task-person").fill(HELPER);
  await form.getByTestId("person-search-result").first().click();
  await expect(form.getByTestId("direct-task-who")).toContainText(
    "For Robin Helper",
  );
  await form.getByLabel("What is the task").fill("Draw the logo.");
  // A required field left empty is marked, the reason is read with it, and the keyboard goes to it.
  await form.getByRole("button", { name: "Make the task" }).click();
  const doneField = form.getByLabel("Done means");
  await expect(doneField).toBeFocused();
  await expect(doneField).toHaveAttribute("aria-invalid", "true");
  await expect(doneField).toHaveAttribute("aria-required", "true");
  await expect(doneField).toHaveAccessibleDescription(
    /Say what finished looks like, so the work can be checked\./,
  );
  await doneField.fill("An SVG the team agrees on.");
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(tasks.getByTestId("tasks-said")).toHaveText(
    "Task made. It is Robin Helper's once they say yes.",
  );
  const row = tasks.getByTestId("task");
  await expect(row).toHaveAttribute("data-state", "offered");

  await expect(row.getByTestId("task-who")).toContainText(
    "Given to Robin Helper, who has not said yes",
  );

  // A visitor is not shown a task nobody has said yes to, and the person's profile says nothing of it.
  await openAs(page, null, PROJECT);
  // Once the tasks were read (the record card says when), the card that lists them is not there.
  await expect(page.getByTestId("project-record")).toHaveAttribute(
    "data-work-read",
    "true",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("project-tasks")).toHaveCount(0);
  await expect(page.getByText("Draw the logo.")).toHaveCount(0);
  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByTestId("track-record-empty")).toBeVisible();

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
  await expect(tasks.getByTestId("tasks-said")).toContainText(
    "An earlier try had already gone through, so nothing new was sent.",
  );
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
  seedStep(
    relay,
    HELPER,
    seedTask(relay, { offerId: seeded.offer.id }),
    "accept",
  );
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

test("naming someone's offer puts them on nothing: no public task, nothing on their profile, and they can say no without a mark", async ({
  page,
}) => {
  const relay = createMockRelay();
  const seeded = seedProject(relay);
  // The project names Robin's offer, dates the task long past, and "sends back" work Robin never handed in.
  const task = seedTask(relay, {
    offerId: seeded.offer.id,
    due: "2020-01-01",
    what: "Rebuild the whole app.",
  });
  seedStep(
    relay,
    MATE,
    task,
    "send-back",
    [["task-evidence", "e".repeat(64)]],
    "Late and bad.",
  );
  await install(page, relay, null);

  // The public: no task, nothing late, nothing on the record.
  await page.goto(PROJECT);
  // Once the tasks were read (the record card says when), the card that lists them is not there.
  await expect(page.getByTestId("project-record")).toHaveAttribute(
    "data-work-read",
    "true",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("project-tasks")).toHaveCount(0);
  await expect(page.getByText("Rebuild the whole app.")).toHaveCount(0);
  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  const track = page.getByTestId("track-record");
  await expect(track.getByTestId("track-record-empty")).toBeVisible();
  await expect(track).not.toContainText(/sent back|in progress|Late/);

  // Robin: the task is theirs to answer, not theirs. It is not late, and there is nothing to give up.
  await openAs(page, HELPER_KEY, PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await expect(row).toHaveAttribute("data-state", "offered");
  await expect(row.getByTestId("task-late")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Give up" })).toHaveCount(0);
  await expect(row.getByTestId("task-step-removed")).toBeVisible();
  // Saying no asks first, from the keyboard, and Escape puts the question away with the keyboard back on the button.
  const no = row.getByRole("button", { name: "No, not for me" });
  await no.focus();
  await page.keyboard.press("Enter");
  const ask = row.getByRole("group", { name: "Say no to this task?" });
  await expect(ask).toContainText("leaves no mark on your record");
  await expect(ask.getByRole("button", { name: "Yes, say no" })).toBeFocused();
  expect(parts(relay, "give-up")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(no).toBeFocused();
  await no.click();
  await ask.getByRole("button", { name: "Yes, say no" }).click();
  await expect.poll(() => parts(relay, "give-up").length).toBe(1);

  // After the no: still nothing public, no line on the project's record, nothing on the profile.
  await openAs(page, null, PROJECT);
  // Once the tasks were read (the record card says when), the card that lists them is not there.
  await expect(page.getByTestId("project-record")).toHaveAttribute(
    "data-work-read",
    "true",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("project-tasks")).toHaveCount(0);
  await expect(page.getByTestId("record-task-closed")).toHaveCount(0);
  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(track.getByTestId("track-record-empty")).toBeVisible();
});

test("a stranger's flood of records naming the project and the helper cuts no read and changes no number", async ({
  page,
}) => {
  const STRANGER = pubkeyOf("7".repeat(64));
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  const work = seedStep(relay, HELPER, task, "evidence", [], "Fixed.");
  seedStep(relay, MATE, task, "confirm", [["task-evidence", work.id]]);
  // Junk in one second, with every tag a read by tag would look for.
  const at = now();
  for (let i = 0; i < 700; i += 1)
    relay.seed(
      event(
        47003,
        STRANGER,
        { title: "junk", body: "" },
        [
          ["a", COORD],
          ["l", "creaton-task"],
          ["task-part", "send-back"],
          ["e", task.id],
          ["task", task.id],
          ["p", HELPER],
          ["task-evidence", work.id],
        ],
        at,
      ),
    );
  await install(page, relay, null);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-work-totals")).toHaveText(
    "1 piece of work accepted",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("tasks-read-cut")).toHaveCount(0);
  await expect(record.getByTestId("record-work-cut")).toHaveCount(0);

  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  const track = page.getByTestId("track-record");
  await expect(track.getByTestId("track-record-accepted")).toHaveText(
    "1 piece of work accepted, on 1 project, confirmed by 1 person",
    { timeout: 30_000 },
  );
  await expect(track.getByTestId("track-record-cut")).toHaveCount(0);
  // The strangers' "send-backs" are not counted against the helper.
  await expect(track.getByTestId("track-record-misses")).toHaveCount(0);
});

test("a check is of the piece that was read: the box shows it, and work handed in meanwhile stops the confirmation", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  seedStep(relay, HELPER, task, "evidence", [], "The first version.");
  await install(page, relay, MATE_KEY);
  await page.goto(PROJECT);
  const tasks = page.getByTestId("project-tasks");
  const row = tasks.getByTestId("task");
  const confirmButton = row.getByRole("button", { name: "Confirm it's done" });
  await confirmButton.click();
  // A labelled group, with the keyboard on its first control and the piece being confirmed inside it.
  const box = row.getByRole("group", { name: "Confirm this work?" });
  await expect(box.getByRole("button", { name: "Yes, confirm" })).toBeFocused();
  await expect(box.getByTestId("task-confirm-piece")).toContainText(
    "The first version.",
  );
  // "Not yet" (and Escape) gives the keyboard back to the button that opened the box.
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(confirmButton).toBeFocused();

  // The box is open on the first version when the helper hands in a different one.
  await confirmButton.click();
  seedStep(relay, HELPER, task, "evidence", [], "A different version.");
  await box.getByRole("button", { name: "Yes, confirm" }).click();
  await expect(tasks.getByTestId("tasks-said")).toHaveText(
    "More work was handed in on this task while you were reading, so nothing was sent. Read what is there now, then answer it.",
  );
  expect(parts(relay, "confirm")).toHaveLength(0);
  // Both pieces now wait, each with its own check.
  await expect(row.getByTestId("task-evidence")).toHaveCount(2);
  await expect(
    row.getByRole("button", { name: /^Confirm it's done \(piece \d\)$/ }),
  ).toHaveCount(2);
  await expect(
    row.getByRole("button", { name: /^Send back \(piece \d\)$/ }),
  ).toHaveCount(2);
});

test("a handed-in file's fingerprint is called unchecked until Check this file compares it, and a link shows where it goes", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Record sign-up." });
  // sha256("hello world")
  const real =
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
  seedStep(
    relay,
    HELPER,
    task,
    "evidence",
    [
      ["task-link", "https://good.example@evil.example/recording"],
      [
        "task-file",
        real,
        "recording.mp4",
        `http://${COMMUNITY_HOST}/blob/real`,
      ],
      [
        "task-file",
        "c".repeat(64),
        "invoice.pdf",
        `http://${COMMUNITY_HOST}/blob/other`,
      ],
    ],
    "See the files.",
  );
  await install(page, relay, null);
  await page.route("**/blob/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/mp4",
      body: "hello world",
    }),
  );
  await page.goto(PROJECT);
  const piece = page.getByTestId("project-tasks").getByTestId("task-evidence");
  // The link's real site is said beside it, whatever the address looks like.
  await expect(piece.getByTestId("task-link-host")).toHaveText(
    "(goes to evil.example)",
  );
  const files = piece.getByTestId("task-file");
  await expect(files).toHaveCount(2);
  await expect(files.first()).toContainText(
    "Fingerprint stated by the helper, not checked here:",
  );
  await expect(files.first().getByTestId("task-file-check")).toHaveCount(0);
  await files
    .first()
    .getByRole("button", { name: "Check this file: recording.mp4" })
    .click();
  await expect(files.first().getByTestId("task-file-check")).toHaveText(
    "Checked just now: the file at this address matches the fingerprint.",
  );
  await files
    .nth(1)
    .getByRole("button", { name: "Check this file: invoice.pdf" })
    .click();
  await expect(files.nth(1).getByTestId("task-file-check")).toContainText(
    "does NOT match the fingerprint",
  );
});

test("a give-up stays on both records when the work is confirmed afterwards", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  seedStep(relay, HELPER, task, "accept");
  seedStep(relay, HELPER, task, "give-up", [], "No time this month.");
  const work = seedStep(relay, HELPER, task, "evidence", [], "Did it anyway.");
  seedStep(relay, MATE, task, "confirm", [["task-evidence", work.id]]);
  await install(page, relay, null);
  await page.goto(PROJECT);
  const record = page.getByTestId("project-record");
  await expect(record.getByTestId("record-work-accepted")).toContainText(
    "Fix the invite email.",
  );
  await expect(record.getByTestId("record-task-closed")).toContainText(
    "Robin Helper gave it up: No time this month. Work on it was confirmed all the same",
  );
  await page.goto(`/u/${HELPER}`);
  await page.getByRole("tab", { name: "Record" }).click();
  await expect(page.getByTestId("track-record-misses")).toHaveText(
    "0 tasks sent back at least once, 1 given up",
  );
  await expect(page.getByTestId("track-record-accepted")).toContainText(
    "1 piece of work accepted",
  );
});

test("a step the server refuses says why in plain words, with what to do, and keeps what was written", async ({
  page,
}) => {
  // The page thinks Max is on the team; the server's copy of the project says otherwise (the founder just took
  // them off). The server's own wording comes back, and the page says it for people.
  const relay = createMockRelay({
    refuse: (e) =>
      e.pubkey === MATE && e.kind === 47003
        ? "restricted: only this project's team can post this"
        : null,
  });
  seedProject(relay, { offer: false });
  const task = seedTask(relay, { what: "Fix the invite email." });
  seedStep(relay, HELPER, task, "evidence", [], "Fixed.");
  await install(page, relay, MATE_KEY);
  await page.goto(PROJECT);
  const row = page.getByTestId("project-tasks").getByTestId("task");
  await row.getByRole("button", { name: "Send back" }).click();
  const back = row.getByRole("form", { name: "Send the work back" });
  await back.getByLabel("What is missing").fill("There is no recording.");
  await back.getByRole("button", { name: "Send back" }).click();
  const failed = back.getByTestId("task-send-back-box-failed");
  await expect(failed).toContainText(
    "The work was not sent back. Only this project's team can post this. If you should be on the team, ask the founder to add you to the project, then try again.",
  );
  await expect(failed).not.toContainText("restricted");
  await expect(back.getByLabel("What is missing")).toHaveValue(
    "There is no recording.",
  );
  expect(parts(relay, "send-back")).toHaveLength(0);
});

test("the server's own rules hold on the test server: only the team, the named helper, and never the helper's own confirmation", async () => {
  const relay = createMockRelay();
  const STRANGER = pubkeyOf("7".repeat(64));
  seedProject(relay, { offer: false });
  const task = seedTask(relay);
  const step = (by: string, part: string, extra: string[][] = []) =>
    projectRecordRefusal(
      event(
        47003,
        by,
        {},
        [["a", COORD], ["task-part", part], ["task", task.id], ...extra],
        now(),
      ),
      relay.events,
    );
  expect(step(HELPER, "accept")).toBeNull();
  expect(step(STRANGER, "accept")).toBe(
    "restricted: only the helper this task names can post this",
  );
  expect(step(MATE, "confirm")).toBeNull();
  expect(step(HELPER, "confirm")).toBe(
    "restricted: only this project's team can post this",
  );
  expect(step(STRANGER, "send-back")).toBe(
    "restricted: only this project's team can post this",
  );
  // The founder doing their own task cannot confirm it.
  const own = seedTask(relay, { helper: FOUNDER });
  expect(
    projectRecordRefusal(
      event(
        47003,
        FOUNDER,
        {},
        [
          ["a", COORD],
          ["task-part", "confirm"],
          ["task", own.id],
        ],
        now(),
      ),
      relay.events,
    ),
  ).toBe(
    "restricted: a task's work must be confirmed by someone other than its helper",
  );
  expect(
    projectRecordRefusal(
      event(
        47003,
        MATE,
        {},
        [
          ["a", COORD],
          ["promise", "0", "x"],
        ],
        now(),
      ),
      relay.events,
    ),
  ).toBe("restricted: only this project's founder can post this");
  expect(
    projectRecordRefusal(
      event(
        47003,
        FOUNDER,
        {},
        [
          ["a", `37001:${FOUNDER}:gone`],
          ["update-kind", "weekly"],
        ],
        now(),
      ),
      relay.events,
    ),
  ).toBe("invalid: this record names a project that is not on this server");
  // A removal names exactly one record, never another removal, and its `k` names the real kind.
  const del = (tags: string[][]) =>
    deletionRefusal(event(5, FOUNDER, "", tags, now()), relay.events);
  expect(
    del([
      ["e", task.id],
      ["k", "47003"],
    ]),
  ).toBeNull();
  expect(
    del([
      ["e", task.id],
      ["e", own.id],
    ]),
  ).toContain("exactly one target");
  expect(
    del([
      ["e", task.id],
      ["k", "1"],
    ]),
  ).toContain("`k` tag names kind 1");
  const removal = event(5, FOUNDER, "", [["e", task.id]], now());
  relay.seed(removal);
  expect(del([["e", removal.id]])).toContain("a deletion cannot be deleted");
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
  // And more of the helper's own steps than a page holds, for their profile.
  for (let i = 0; i < 500; i += 1)
    relay.seed(
      event(
        47003,
        HELPER,
        { title: "accept", body: "" },
        [
          ["a", COORD],
          ["l", "creaton-task"],
          ["task-part", "accept"],
          ["e", task.id],
          ["task", task.id],
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
  // And nothing is listed as accepted from a read that did not finish.
  await expect(track.getByTestId("track-work")).toHaveCount(0);
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
