import { expect as baseExpect, test, type Page } from "@playwright/test";
import { decrypt as nip49Decrypt } from "nostr-tools/nip49";

import {
  type Account,
  type StoredEvent,
  accountFromKey,
  buzz,
  closeBrowsers,
  newAccount,
  ownBrowserPage,
  publishAs,
  publishManyAs,
  readAs,
  shot,
  tagOf,
} from "./project-loop-helpers";

/**
 * A project's loop from Quick Start to accepted work, against a REAL server (`scripts/real-loop-e2e.sh` boots it):
 * three people in browsers of their own, a fourth who only uses the `buzz` command line, and a stranger who only has a
 * socket. Nothing is mocked: every record is signed in the browser (or by the CLI), checked by the server's own rules
 * (`crates/buzz-relay/src/handlers/launch_update_authority.rs`) and read back from Postgres.
 *
 * The tests share one project and run in order; each one is a flow a person would name. A later test needs what an
 * earlier one made, so the file stops at the first failure.
 */

// A page here makes a few dozen signed-in reads, each on a connection of its own, with three browsers open at once:
// what a step is waited for is the app's own patience with a slow server, not the mock's instant answer.
const expect = baseExpect.configure({ timeout: 20_000 });

test.describe.configure({ mode: "serial", retries: 0 });
test.afterAll(closeBrowsers);

// A tag of this run's own, so a second run on the same database never reads the first one's people or project.
const RUN = Date.now().toString(36).slice(-5);
const PROJECT_NAME = `Nebula ${RUN}`;
const SLUG = `nebula-${RUN}`;
const GOAL = "A first version ten people use";
const HOW = "Ten people sign in in a week";
const ASK = "Someone to test sign-up on an older phone.";
const DONE = "A screen recording of sign-up working on Android 9.";
const CLI_DONE = "A written list of every step that failed.";

let founder: Account;
const helper = newAccount(`Robin ${RUN}`);
const mate = newAccount(`Max ${RUN}`);
const cliHelper = newAccount(`Casey ${RUN}`);
const stranger = newAccount(`Sam ${RUN}`);
const FOUNDER_NAME = `Fay ${RUN}`;

let founderPage: Page;
let helperPage: Page;
let matePage: Page;

let coord = "";
let projectPath = "";
let helpUpdateId = "";
let webTaskId = "";
let cliTaskId = "";

const record = (page: Page) => page.getByTestId("project-record");
const taskRow = (page: Page, what: string) =>
  page
    .getByTestId("project-tasks")
    .getByTestId("task")
    .filter({ hasText: what });

/** The project's records of one family, read straight from the server. */
const projectRecords = async (tagName: string) =>
  (
    await readAs(stranger, { kinds: [47003], "#a": [coord], limit: 500 })
  ).filter((e) => e.tags.some((t) => t[0] === tagName));

const taskSteps = async (part: string) =>
  (await projectRecords("task-part")).filter(
    (e) => tagOf(e, "task-part") === part,
  );

/** The founder's project record with `team` as its listed team (the founder is always on it). */
async function setTeam(team: Account[]) {
  const [current] = await readAs(founder, {
    kinds: [37001],
    authors: [founder.pubkey],
    "#d": [SLUG],
  });
  expect(current, "the project record is on the server").toBeTruthy();
  const answer = await publishAs(founder, {
    kind: 37001,
    content: current.content,
    tags: [
      ...current.tags.filter((t) => t[0] !== "team"),
      ...team.map((m) => ["team", m.pubkey, "Reviewer"]),
    ],
    created_at: Math.max(Math.floor(Date.now() / 1000), current.created_at + 1),
  });
  expect(answer.reason, "the founder's own project record is stored").toBe("");
  expect(answer.accepted).toBe(true);
}

/**
 * The founder adds the second member from the project page's Team section, and that person says yes in a browser of
 * their own. Read back from the server: the founder's record names them (with a `p` tag they are found by), their own
 * signed answer names the invitation, and everyone then sees them as team.
 */
async function addMateThroughTheTeamSection() {
  await founderPage.goto(projectPath);
  const team = founderPage.getByTestId("project-team");
  await team.getByTestId("team-add").click();
  await expect(founderPage.getByTestId("team-add-warning")).toContainText(
    "They can act for this project as soon as you add them.",
  );
  await founderPage.getByTestId("team-add-search").fill(mate.pubkey);
  await founderPage.getByTestId("person-search-result").first().click();
  await expect(founderPage.getByTestId("team-add-picked")).toContainText(
    `Add ${mate.name} to the team?`,
  );
  await founderPage.getByTestId("team-add-confirm").click();
  // Shown at once, before the server has shown the record back.
  await expect(team.getByTestId("team-invited-member")).toContainText(
    mate.name,
  );
  const teamTag = async () => {
    const [current] = await readAs(stranger, {
      kinds: [37001],
      authors: [founder.pubkey],
      "#d": [SLUG],
    });
    return {
      tag: current?.tags.find((t) => t[0] === "team" && t[1] === mate.pubkey),
      record: current,
    };
  };
  await expect.poll(async () => (await teamTag()).tag?.[2]).toBe("member");
  const { tag, record: saved } = await teamTag();
  // Exactly the three parts the server requires of a team tag; the invitation's name sits in a tag beside it.
  expect(tag).toEqual(["team", mate.pubkey, "member"]);
  const invite =
    saved.tags.find(
      (t) => t[0] === "team-invite" && t[1] === mate.pubkey,
    )?.[2] ?? "";
  expect(invite).toMatch(/^[a-z0-9]{12}$/);
  expect(saved.tags).toContainEqual(["p", mate.pubkey]);
  // The rest of the record survived the save.
  expect(tagOf(saved, "name")).toBe(PROJECT_NAME);
  // The server finds the project by the person it names: this is the read their invitation comes from.
  const naming = await readAs(mate, {
    kinds: [37001],
    "#p": [mate.pubkey],
    limit: 100,
  });
  expect(naming.map((e) => tagOf(e, "d"))).toContain(SLUG);

  // Before they answer, everyone reads that they have not said yes.
  await helperPage.goto(projectPath);
  await expect(
    helperPage.getByTestId("project-team").getByTestId("team-invited-member"),
  ).toContainText("Has not said yes yet");

  // They find the invitation in Notifications and say yes on the project's page.
  await matePage.goto("/social/notifications");
  await expect(matePage.getByTestId("social-team-invitation")).toContainText(
    PROJECT_NAME,
  );
  await matePage.goto(projectPath);
  const mateTeam = matePage.getByTestId("project-team");
  await expect(mateTeam.getByTestId("team-invitation")).toContainText(
    "added you to this project's team",
  );
  await mateTeam.getByTestId("team-join").click();
  await expect(mateTeam.getByTestId("team-answered")).toHaveText(
    "You joined the team.",
  );
  await expect
    .poll(async () => (await projectRecords("team-answer")).length)
    .toBe(1);
  const [yes] = await projectRecords("team-answer");
  expect(yes.pubkey).toBe(mate.pubkey);
  expect(tagOf(yes, "team-answer")).toBe("yes");
  expect(tagOf(yes, "team-invite")).toBe(invite);
  // The answers are read by project and label together, as the page reads them.
  const labelled = await readAs(stranger, {
    kinds: [47003],
    authors: [mate.pubkey],
    "#a": [coord],
    "#l": ["creaton-team"],
    limit: 200,
  });
  expect(labelled.map((e) => e.id)).toEqual([yes.id]);

  // Read back by someone else: they are team now.
  await helperPage.reload();
  await expect(
    helperPage.getByTestId("project-team").getByTestId("team-member"),
  ).toContainText(mate.name);
}

/**
 * A team member who said yes posts an update from the web. The server takes it (it checks the signer against the
 * project record), it carries no promise (those are the founder's alone), and everyone reads it with the project's news.
 */
async function teamMemberPostsAnUpdate() {
  await matePage.goto(projectPath);
  await matePage.getByTestId("team-post-update").click();
  await expect(matePage.getByTestId("update-as-team")).toBeVisible();
  await matePage.getByLabel("Title").fill(`From the team ${RUN}`);
  await matePage
    .getByLabel("What happened this week")
    .fill("Checked the sign-up flow.");
  await matePage.getByLabel("What's next").fill("Write the install guide");
  await matePage.getByRole("button", { name: "Publish update" }).click();
  const fromMate = async () =>
    (await projectRecords("update-part")).filter(
      (e) => e.pubkey === mate.pubkey,
    );
  await expect.poll(async () => (await fromMate()).length).toBe(1);
  const [posted] = await fromMate();
  expect(posted.tags.some((t) => t[0] === "promise")).toBe(false);
  expect(posted.tags.some((t) => t[0] === "promise-mark")).toBe(false);
  // Everyone reads it with the project's news, under the member's name.
  await helperPage.goto(`${projectPath}&tab=updates`);
  await expect(
    helperPage.getByText(`From the team ${RUN}`).first(),
  ).toBeVisible();
}

/**
 * The same records, read the way Home and "Your projects" read them, from the real server: by who signed them, with
 * the filters those pages send. The helper's feed is their own (they have tasks on the project); the founder's page
 * lists the project with its promises totalled, and Home's next step reads without a failure.
 */
async function theRecordIsReadOnHomeAndOnYourProjects() {
  await helperPage.goto("/?tab=updates");
  const feed = helperPage.getByTestId("record-feed");
  await expect(feed.getByTestId("record-feed-scope")).toHaveAttribute(
    "data-mode",
    "yours",
  );
  const cards = feed.getByTestId("record-card");
  // Newest first: the team member's update just posted leads.
  await expect(cards.first()).toContainText(`From the team ${RUN}`);
  // Work the team accepted is on it, worked out from the tasks' own records: the two pieces confirmed above (the
  // web helper's and the command-line helper's), as the project's own record counts them.
  const accepted = cards.filter({ hasText: "Work accepted" });
  await expect(accepted).toHaveCount(2);
  await expect(accepted.filter({ hasText: helper.name })).toHaveCount(1);
  await expect(accepted.filter({ hasText: cliHelper.name })).toHaveCount(1);
  await expect(feed.getByTestId("record-feed-failed")).toHaveCount(0);
  await expect(feed).not.toContainText(/\$|earn/i);

  await founderPage.goto("/portfolio");
  const mine = founderPage
    .getByTestId("your-projects-started")
    .getByTestId("your-project")
    .filter({ hasText: PROJECT_NAME });
  await expect(mine.getByTestId("your-project-update")).toHaveText(
    "Updated today",
  );
  // Three promises were made and answered in test 3: the totals are stated, so the founder's updates were all read.
  await expect(mine.getByTestId("your-project-promises")).toContainText(
    /\d+ kept, \d+ missed, \d+ changed/,
  );
  await expect(mine.getByTestId("your-project-help")).not.toContainText(
    "Not known",
  );
  await expect(mine.getByTestId("your-project-failed")).toHaveCount(0);

  // Home's next step reads the same facts: whatever it finds, it does not fail.
  await founderPage.goto("/");
  await expect(founderPage.getByTestId("home-top")).toBeVisible();
  await expect(founderPage.getByTestId("home-yours")).toBeVisible();
  await expect(founderPage.getByTestId("home-next-step-failed")).toHaveCount(0);
  await shot(founderPage, "09-home-next-step");
}

test("1. three people arrive: one signs up, one signs in with a saved key, one is already signed in", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  // The founder has nothing: no key, no invite. They sign up in the app.
  founderPage = await ownBrowserPage(browser);
  await founderPage.goto("/");
  await founderPage.getByTestId("create-identity-cta").first().click();
  await founderPage.getByTestId("onboarding-name").fill(FOUNDER_NAME);
  await founderPage.getByTestId("onboarding-create").click();
  await expect(founderPage.getByTestId("user-chip")).toBeVisible();
  // The key is stored sealed beside what unseals it; the test reads whose it is, to act as the founder on a socket.
  const [sealed, wrap] = await founderPage.evaluate(() => [
    window.localStorage.getItem("buzz.identity.nsec") ?? "",
    window.localStorage.getItem("buzz.identity.wrap") ?? "",
  ]);
  founder = accountFromKey(nip49Decrypt(sealed, wrap), FOUNDER_NAME);
  // The name they chose reached the server.
  await expect
    .poll(async () => {
      const [profile] = await readAs(stranger, {
        kinds: [0],
        authors: [founder.pubkey],
      });
      return profile
        ? (JSON.parse(profile.content) as { name?: string }).name
        : "";
    })
    .toBe(FOUNDER_NAME);

  // The helper has an account from elsewhere: they sign in with the key they saved.
  for (const person of [helper, mate, cliHelper]) {
    const named = await publishAs(person, {
      kind: 0,
      content: JSON.stringify({ name: person.name }),
      tags: [],
    });
    expect(named.reason).toBe("");
  }
  helperPage = await ownBrowserPage(browser);
  await helperPage.goto("/");
  await helperPage.getByTestId("create-identity-cta").first().click();
  await helperPage.getByTestId("onboarding-signin").click();
  await helperPage.getByTestId("onboarding-signin-key").fill(helper.hexKey);
  await helperPage.getByTestId("onboarding-signin-submit").click();
  await expect(helperPage.getByTestId("user-chip")).toBeVisible();

  // The second team member comes back to a browser that already holds their account.
  matePage = await ownBrowserPage(browser);
  await matePage.addInitScript((key) => {
    if (!window.localStorage.getItem("buzz.identity.nsec")) {
      window.localStorage.setItem("buzz.identity.nsec", key);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
    }
  }, mate.hexKey);
  await matePage.goto("/");
  await expect(matePage.getByTestId("user-chip")).toBeVisible();
});

test("2. Quick Start: four answers make the project and its goal, and a reload keeps them", async () => {
  test.setTimeout(120_000);
  const page = founderPage;
  await page.goto("/start");
  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill(PROJECT_NAME);
  await form
    .getByLabel("What is it, in one sentence?")
    .fill("A star map anyone can add to");
  await form.getByLabel("The goal").fill(GOAL);
  await form.getByLabel("How we'll know").fill(HOW);
  await form.getByRole("button", { name: "Start the project" }).click();

  const goal = page.getByTestId("project-goal");
  await expect(goal.getByTestId("goal-text")).toHaveText(GOAL);
  await expect(goal.getByTestId("goal-how")).toContainText(HOW);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    PROJECT_NAME,
  );
  expect(new URL(page.url()).pathname).toBe(`/launchpad/${SLUG}`);
  projectPath = `/launchpad/${SLUG}?author=${founder.pubkey}`;
  coord = `37001:${founder.pubkey}:${SLUG}`;

  await page.reload();
  await expect(goal.getByTestId("goal-text")).toHaveText(GOAL);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    PROJECT_NAME,
  );

  // The server holds exactly one project record and one goal, both the founder's.
  const projects = await readAs(stranger, {
    kinds: [37001],
    authors: [founder.pubkey],
  });
  expect(projects.map((e) => tagOf(e, "d"))).toEqual([SLUG]);
  const goals = await projectRecords("goal");
  expect(goals).toHaveLength(1);
  expect(goals[0].pubkey).toBe(founder.pubkey);
  expect(tagOf(goals[0], "goal-text")).toBe(GOAL);

  // Someone else, signed in, reads the same page; so does the command line.
  await helperPage.goto(projectPath);
  await expect(helperPage.getByTestId("goal-text")).toHaveText(GOAL);
  const listed = await buzz(cliHelper, [
    "launchpad",
    "tasks",
    "list",
    SLUG,
    "--author",
    founder.pubkey,
  ]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.json).toMatchObject({
    project: { coordinate: coord, name: PROJECT_NAME },
    tasks: [],
  });

  // A project started with the short form is public and listed: someone else finds it in Discover and in Home's side
  // panel, with nothing more done to it. Its founder reads on its page that it is listed.
  await helperPage.goto("/discover");
  await expect(
    helperPage
      .getByTestId("discover-launch-list")
      .getByText(PROJECT_NAME, { exact: true }),
  ).toBeVisible();
  await helperPage.goto("/");
  await expect(
    helperPage
      .getByTestId("social-rail-projects")
      .getByText(PROJECT_NAME, { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("project-listing-state")).toContainText(
    "Listed.",
  );
  await shot(page, "02-project");
});

test("3. weekly updates: three promises, the next update answers each, the record totals them, and a missed goal keeps its reason", async () => {
  test.setTimeout(180_000);
  const page = founderPage;
  await page.goto(projectPath);

  await page.getByRole("button", { name: "Post update" }).click();
  let dialog = page.getByRole("dialog", { name: "Post update" });
  await dialog.getByLabel("Title").fill("Week one");
  await dialog.getByLabel("What happened this week").fill("Set up the repo.");
  await dialog
    .getByLabel("What's next")
    .fill("- Ship sign-up\n- Write the guide\n- Find a designer");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(record(page).getByTestId("record-line")).toHaveCount(3);
  await expect(record(page).getByTestId("record-line").first()).toContainText(
    "Promised",
  );
  const promised = await projectRecords("promise");
  expect(promised).toHaveLength(1);
  expect(promised[0].tags.filter((t) => t[0] === "promise")).toEqual([
    ["promise", "0", "Ship sign-up"],
    ["promise", "1", "Write the guide"],
    ["promise", "2", "Find a designer"],
  ]);

  // The second update answers each, and asks for help.
  await page.getByRole("button", { name: "Post update" }).click();
  dialog = page.getByRole("dialog", { name: "Post update" });
  await expect(dialog.getByTestId("update-due-promise")).toHaveCount(3);
  const answer = (text: string) => dialog.getByRole("group", { name: text });
  await answer("Ship sign-up")
    .getByRole("radio", { name: "Done", exact: true })
    .check();
  await answer("Write the guide")
    .getByRole("radio", { name: "Not done" })
    .check();
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
  await dialog.getByLabel("What happened this week").fill("Sign-up shipped.");
  await dialog.getByLabel("What's next").fill("Invite ten people");
  await dialog.getByLabel("Help needed (optional)").fill(ASK);
  await dialog.getByRole("radio", { name: "Small" }).check();
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(record(page).getByTestId("record-promise-totals")).toHaveText(
    "1 kept, 1 missed, 1 changed",
  );
  const lines = record(page).getByTestId("record-line");
  await expect(lines.filter({ hasText: "Write the guide" })).toContainText(
    "ran out of time",
  );
  await expect(lines.filter({ hasText: "Invite ten people" })).toContainText(
    "For the next update",
  );
  const marks = await projectRecords("promise-mark");
  expect(marks).toHaveLength(1);
  expect(marks[0].tags.filter((t) => t[0] === "promise-mark")).toEqual([
    ["promise-mark", `${promised[0].id}:0`, "done", ""],
    ["promise-mark", `${promised[0].id}:1`, "not-done", "ran out of time"],
    ["promise-mark", `${promised[0].id}:2`, "changed", "doing it ourselves"],
  ]);
  helpUpdateId = marks[0].id;
  expect(tagOf(marks[0], "help-needed")).toBe(ASK);

  // The goal is missed, with its one line of why.
  const goal = page.getByTestId("project-goal");
  await goal.getByRole("button", { name: "Update this goal" }).click();
  let goalDialog = page.getByRole("dialog", { name: "Update this goal" });
  await goalDialog.getByRole("radio", { name: "Missed" }).check();
  await goalDialog
    .getByLabel("Why was it missed?")
    .fill("Sign-up took too long");
  await goalDialog.getByRole("button", { name: "Save goal" }).click();
  await expect(goalDialog).toHaveCount(0);
  await expect(goal.getByTestId("goal-state")).toHaveText("Missed");
  await expect(goal.getByTestId("goal-reason")).toHaveText(
    "Why: Sign-up took too long",
  );
  await expect(record(page).getByTestId("record-goal-totals")).toHaveText(
    "0 goals reached, 1 missed, 0 changed",
  );

  // Reworded and opened again: the miss stays in its history and in the totals.
  await goal.getByRole("button", { name: "Update this goal" }).click();
  goalDialog = page.getByRole("dialog", { name: "Update this goal" });
  await goalDialog
    .getByLabel("The goal")
    .fill("A first version five people use");
  await goalDialog.getByRole("radio", { name: "Open" }).check();
  await goalDialog.getByLabel("Why did it change?").fill("Ten was too many");
  await goalDialog.getByRole("button", { name: "Save goal" }).click();
  await expect(goalDialog).toHaveCount(0);
  await expect(goal.getByTestId("goal-text")).toHaveText(
    "A first version five people use",
  );

  // All of it is still there after a reload, and for someone who is not the founder.
  for (const reader of [page, helperPage]) {
    await reader.goto(projectPath);
    await expect(reader.getByTestId("goal-text")).toHaveText(
      "A first version five people use",
    );
    const history = reader
      .getByTestId("project-goal")
      .getByTestId("goal-history")
      .first();
    await history.locator("summary").click();
    await expect(history).toContainText("Why: Sign-up took too long");
    await expect(history).toContainText(`It was: ${GOAL}`);
    await expect(
      record(reader).getByTestId("record-promise-totals"),
    ).toHaveText("1 kept, 1 missed, 1 changed");
    await expect(record(reader).getByTestId("record-goal-totals")).toHaveText(
      "0 goals reached, 1 missed, 0 changed",
    );
  }
  await shot(page, "03-record");
});

test("4. help: an offer from the web and one from the command line, a reply, Help found, Reopen, Withdraw, and one removal per record", async () => {
  test.setTimeout(180_000);

  // The helper offers on the project page.
  await helperPage.goto(projectPath);
  const request = helperPage
    .getByTestId("project-update-card")
    .getByTestId("help-request");
  await expect(request).toContainText(ASK);
  await request.getByRole("button", { name: "I can help" }).click();
  const box = request.getByTestId("help-offer-box");
  await box
    .getByLabel("Add a short note (optional)")
    .fill("I have an old phone and an hour tonight.");
  await box.getByRole("button", { name: "Send offer" }).click();
  await expect(request.getByTestId("help-my-offer")).toContainText(
    "I have an old phone and an hour tonight.",
  );

  // The command line reads the request and offers too; a second offer from the same account is a conflict.
  const project = ["launchpad", "tasks"];
  const at = [SLUG, "--author", founder.pubkey];
  const before = await buzz(cliHelper, [...project, "list", ...at]);
  expect(before.code, before.stderr).toBe(0);
  expect(before.json).toMatchObject({
    help_requests: [
      { update_id: helpUpdateId, text: ASK, offered_by_me: false },
    ],
  });
  const offered = await buzz(cliHelper, [
    ...project,
    "offer",
    ...at,
    "--update",
    helpUpdateId,
    "--note",
    "I can write up what breaks.",
  ]);
  expect(offered.code, offered.stderr).toBe(0);
  expect(offered.json).toMatchObject({ accepted: true });
  const again = await buzz(cliHelper, [
    ...project,
    "offer",
    ...at,
    "--update",
    helpUpdateId,
  ]);
  expect(again.code, "a second offer is a conflict").toBe(5);

  // The founder is told, sees both offers with who made them, and replies to the first.
  await founderPage.goto("/social/notifications");
  await expect(
    founderPage
      .getByTestId("social-help-notice")
      .filter({ hasText: helper.name }),
  ).toContainText(`${helper.name} offered to help with “Week two”`);
  await founderPage.goto(projectPath);
  const listed = founderPage
    .getByTestId("project-update-card")
    .getByTestId("help-request");
  const offers = listed.getByTestId("help-offer");
  await expect(offers).toHaveCount(2);
  const webOffer = offers.filter({ hasText: helper.name });
  await expect(webOffer).toContainText(
    "I have an old phone and an hour tonight.",
  );
  await expect(offers.filter({ hasText: cliHelper.name })).toContainText(
    "I can write up what breaks.",
  );
  await webOffer
    .getByRole("button", { name: `Reply to ${helper.name}`, exact: true })
    .click();
  await webOffer
    .getByLabel(`Reply to ${helper.name}`)
    .fill("Thank you! Tonight?");
  await webOffer.getByRole("button", { name: "Send reply" }).click();
  await expect(webOffer.getByTestId("help-reply")).toContainText(
    "Thank you! Tonight?",
  );

  // Help found, then Reopen: the mark is removed with one removal that names its kind.
  await listed.getByRole("button", { name: "Mark as Help found" }).click();
  await expect(listed.getByTestId("help-found")).toHaveText("Help found");
  await expect
    .poll(async () => (await projectRecords("help-found")).length)
    .toBe(1);
  const [found] = await projectRecords("help-found");
  await listed.getByRole("button", { name: "Reopen" }).click();
  await expect(listed.getByTestId("help-found")).toHaveCount(0);
  await expect
    .poll(async () => (await projectRecords("help-found")).length)
    .toBe(0);
  await expect(offers).toHaveCount(2);

  // The helper reads the reply and takes the offer back: again one removal, one record.
  await helperPage.goto("/social/notifications");
  await expect(helperPage.getByTestId("social-help-notice")).toContainText(
    "replied to your offer to help with “Week two”",
  );
  await helperPage.goto(projectPath);
  const mine = request.getByTestId("help-my-offer");
  await expect(mine.getByTestId("help-reply")).toContainText(
    "Thank you! Tonight?",
  );
  const [mineStored] = (await projectRecords("help-offer")).filter(
    (e) => e.pubkey === helper.pubkey,
  );
  await mine.getByRole("button", { name: "Withdraw offer" }).click();
  await expect(request.getByTestId("help-my-offer")).toHaveCount(0);
  await expect
    .poll(async () => (await projectRecords("help-offer")).map((e) => e.pubkey))
    .toEqual([cliHelper.pubkey]);

  const removals = await readAs(stranger, {
    kinds: [5],
    authors: [founder.pubkey, helper.pubkey],
  });
  const named = (e: StoredEvent, name: string) =>
    e.tags.filter((t) => t[0] === name).map((t) => t[1]);
  expect(
    removals
      .map((e) => ({ by: e.pubkey, e: named(e, "e"), k: named(e, "k") }))
      .sort((x, y) => x.by.localeCompare(y.by)),
  ).toEqual(
    [
      { by: founder.pubkey, e: [found.id], k: ["47003"] },
      { by: helper.pubkey, e: [mineStored.id], k: ["47003"] },
    ].sort((x, y) => x.by.localeCompare(y.by)),
  );

  // The founder's page shows the offer gone and the request open; the helper offers once more, for the task to come.
  await founderPage.goto(projectPath);
  await expect(offers).toHaveCount(1);
  await request.getByRole("button", { name: "I can help" }).click();
  await box
    .getByLabel("Add a short note (optional)")
    .fill("Back again: free on Friday.");
  await box.getByRole("button", { name: "Send offer" }).click();
  await expect(request.getByTestId("help-my-offer")).toContainText(
    "Back again: free on Friday.",
  );
});

test("5. tasks: an offer becomes a task with Done means; handed in, sent back, handed in again, confirmed by someone else; the profile shows it", async () => {
  test.setTimeout(240_000);
  await addMateThroughTheTeamSection();

  // The founder accepts the helper's offer and writes what finished looks like.
  await founderPage.goto(projectPath);
  const offer = founderPage
    .getByTestId("project-update-card")
    .getByTestId("help-offer")
    .filter({ hasText: helper.name });
  await offer
    .getByRole("button", {
      name: `Accept ${helper.name}'s offer and make a task`,
    })
    .click();
  const form = offer.getByRole("form", {
    name: `Make a task for ${helper.name}`,
  });
  await form.getByLabel("Done means").fill(DONE);
  await form.getByLabel("Due date (optional)").fill("2099-01-15");
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(offer.getByTestId("offer-task-made")).toContainText(
    `Task made. It is ${helper.name}'s once they say yes.`,
  );
  await expect.poll(async () => (await taskSteps("task")).length).toBe(1);
  const [task] = await taskSteps("task");
  webTaskId = task.id;
  expect(task.pubkey).toBe(founder.pubkey);
  expect(tagOf(task, "task-helper")).toBe(helper.pubkey);
  expect(tagOf(task, "task-done")).toBe(DONE);
  const founderRow = taskRow(founderPage, ASK);
  await expect(founderRow).toHaveAttribute("data-state", "offered");

  // The helper is told, says yes, and hands work in.
  await helperPage.goto("/social/notifications");
  const notice = helperPage.getByTestId("social-task-notice");
  await expect(notice).toContainText(
    `${FOUNDER_NAME} gave you a task to say yes or no to:`,
  );
  await notice.getByRole("link").first().click();
  const row = taskRow(helperPage, ASK);
  await expect(row).toHaveAttribute("data-state", "offered");
  await row.getByRole("button", { name: "Yes, I'll do it" }).click();
  await expect(row).toHaveAttribute("data-state", "in-progress");
  await row.getByRole("button", { name: "Hand in work" }).click();
  let handIn = row.getByRole("form", { name: "Hand in work" });
  await handIn.getByLabel("What you did").fill("Tested on a Moto G6.");
  await handIn
    .getByLabel("Links (optional, one per line)")
    .fill("https://example.org/first-try");
  await handIn.getByRole("button", { name: "Hand in" }).click();
  await expect(row).toHaveAttribute("data-state", "submitted");
  // The one who did the work is offered no way to check it.
  await expect(
    row.getByRole("button", { name: /Confirm|Send back/ }),
  ).toHaveCount(0);
  const [first] = await taskSteps("evidence");

  // The second team member is told, reads the work and sends it back with a reason.
  await matePage.goto("/social/notifications");
  await expect(
    matePage.getByTestId("social-task-notice").filter({ hasText: "handed in" }),
  ).toContainText(`${helper.name} handed in work for you to check on:`);
  await matePage.goto(projectPath);
  const mateRow = taskRow(matePage, ASK);
  await expect(mateRow.getByTestId("task-evidence")).toContainText(
    "Tested on a Moto G6.",
  );
  await mateRow.getByRole("button", { name: "Send back" }).click();
  const back = mateRow.getByRole("form", { name: "Send the work back" });
  await back.getByLabel("What is missing").fill("There is no recording.");
  await back.getByRole("button", { name: "Send back" }).click();
  await expect(mateRow).toHaveAttribute("data-state", "sent-back");
  const [sentBack] = await taskSteps("send-back");
  expect(sentBack.pubkey).toBe(mate.pubkey);
  expect(tagOf(sentBack, "task-evidence")).toBe(first.id);

  // The helper sees why and hands in again.
  await helperPage.goto(projectPath);
  await expect(row.getByTestId("task-sent-back-reason")).toContainText(
    "There is no recording.",
  );
  await row.getByRole("button", { name: "Hand in again" }).click();
  handIn = row.getByRole("form", { name: "Hand in work" });
  await handIn.getByLabel("What you did").fill("Recorded it this time.");
  await handIn
    .getByLabel("Links (optional, one per line)")
    .fill("https://example.org/recording");
  await handIn.getByRole("button", { name: "Hand in" }).click();
  await expect(row).toHaveAttribute("data-state", "submitted");
  await expect.poll(async () => (await taskSteps("evidence")).length).toBe(2);
  const second = (await taskSteps("evidence")).find((e) => e.id !== first.id);

  // The helper cannot confirm their own work: the page offers nothing, and the server refuses a record sent anyway.
  const own = await publishAs(helper, {
    kind: 47003,
    content: JSON.stringify({ title: "confirm", body: "" }),
    tags: [
      ["a", coord],
      ["l", "creaton-task"],
      ["task-part", "confirm"],
      ["e", task.id],
      ["task", task.id],
      ["task-evidence", second?.id ?? ""],
    ],
  });
  expect(own.accepted).toBe(false);
  expect(own.reason).toBe("restricted: only this project's team can post this");

  // The founder confirms the second piece.
  await founderPage.goto(projectPath);
  await founderRow.getByRole("button", { name: "Confirm it's done" }).click();
  await founderRow
    .getByTestId("task-confirm-box")
    .getByRole("button", { name: "Yes, confirm" })
    .click();
  await expect(
    founderPage.getByTestId("project-tasks").getByTestId("tasks-said"),
  ).toHaveText("You confirmed this work.");
  const confirms = await taskSteps("confirm");
  expect(confirms.map((e) => e.pubkey)).toEqual([founder.pubkey]);
  expect(tagOf(confirms[0], "task-evidence")).toBe(second?.id);

  // It is on the project's record as work accepted, and on the helper's profile for anyone.
  const accepted = record(founderPage).getByTestId("record-work-accepted");
  await expect(accepted).toContainText(ASK);
  await expect(accepted).toContainText(
    `Done by ${helper.name}. Checked by ${FOUNDER_NAME}`,
  );
  await expect(
    record(founderPage).getByTestId("record-work-totals"),
  ).toHaveText("1 piece of work accepted");
  await matePage.goto(`/u/${helper.pubkey}`);
  await matePage.getByRole("tab", { name: "Record" }).click();
  const track = matePage.getByTestId("track-record");
  await expect(track.getByTestId("track-record-accepted")).toHaveText(
    "1 piece of work accepted, on 1 project, confirmed by 1 person",
  );
  await expect(track.getByTestId("track-record-misses")).toHaveText(
    "1 task sent back at least once, 0 given up",
  );
  const item = track.getByTestId("track-work-item");
  await expect(item).toContainText(ASK);
  await expect(
    item.getByRole("link", { name: "https://example.org/recording" }),
  ).toBeVisible();
  await expect(item.getByRole("link", { name: PROJECT_NAME })).toHaveAttribute(
    "href",
    new RegExp(`/launchpad/${SLUG}\\?author=${founder.pubkey}`),
  );
  await shot(matePage, "05-profile-record");
});

test("6. the command line does the helper's side, and the server's rules are said in plain words when they refuse", async () => {
  test.setTimeout(240_000);
  const tasks = ["launchpad", "tasks"];
  const at = [SLUG, "--author", founder.pubkey];

  // The founder makes a task from the command-line helper's offer.
  await founderPage.goto(projectPath);
  const offer = founderPage
    .getByTestId("project-update-card")
    .getByTestId("help-offer")
    .filter({ hasText: cliHelper.name });
  await offer
    .getByRole("button", {
      name: `Accept ${cliHelper.name}'s offer and make a task`,
    })
    .click();
  const form = offer.getByRole("form", {
    name: `Make a task for ${cliHelper.name}`,
  });
  await form.getByLabel("Done means").fill(CLI_DONE);
  await form.getByRole("button", { name: "Make the task" }).click();
  await expect(offer.getByTestId("offer-task-made")).toBeVisible();

  // list: the task is theirs to answer; the web-made record reads the same from the command line.
  type Listed = {
    tasks: Array<{
      task_id: string;
      state: string;
      mine: boolean;
      next: string;
      done_means: string;
    }>;
  };
  const mineOf = async () => {
    const listed = await buzz(cliHelper, [...tasks, "list", ...at]);
    expect(listed.code, listed.stderr).toBe(0);
    return (listed.json as Listed).tasks.filter((t) => t.mine);
  };
  await expect.poll(async () => (await mineOf()).length).toBe(1);
  const [offeredTask] = await mineOf();
  cliTaskId = offeredTask.task_id;
  expect(offeredTask).toMatchObject({ state: "offered", done_means: CLI_DONE });
  expect(cliTaskId).not.toBe(webTaskId);

  // accept and submit from the command line; a second accept is a conflict.
  const accepted = await buzz(cliHelper, [
    ...tasks,
    "accept",
    ...at,
    "--task",
    cliTaskId,
  ]);
  expect(accepted.code, accepted.stderr).toBe(0);
  const twice = await buzz(cliHelper, [
    ...tasks,
    "accept",
    ...at,
    "--task",
    cliTaskId,
  ]);
  expect(twice.code).toBe(5);
  const submitted = await buzz(cliHelper, [
    ...tasks,
    "submit",
    ...at,
    "--task",
    cliTaskId,
    "--note",
    "Three steps failed; listed in the doc.",
    "--link",
    "https://example.org/failures",
  ]);
  expect(submitted.code, submitted.stderr).toBe(0);
  expect((await mineOf())[0]).toMatchObject({
    state: "submitted",
    next: "wait-for-check",
  });
  // Someone else's task is not theirs to touch.
  const notMine = await buzz(cliHelper, [
    ...tasks,
    "accept",
    ...at,
    "--task",
    webTaskId,
  ]);
  expect(notMine.code).toBe(1);

  // The web reads what the command line wrote: the second member sees the work, ready to check.
  await matePage.goto(projectPath);
  const mateRow = taskRow(matePage, "I can write up what breaks.").or(
    taskRow(matePage, CLI_DONE),
  );
  await expect(mateRow).toHaveAttribute("data-state", "submitted");
  await expect(mateRow.getByTestId("task-evidence")).toContainText(
    "Three steps failed; listed in the doc.",
  );
  await expect(
    mateRow.getByRole("link", { name: "https://example.org/failures" }),
  ).toBeVisible();

  // While their page is open the founder takes them off the team. The server refuses their confirmation, and the
  // page says why in words a person can act on.
  await setTeam([]);
  await mateRow.getByRole("button", { name: "Confirm it's done" }).click();
  await mateRow
    .getByTestId("task-confirm-box")
    .getByRole("button", { name: "Yes, confirm" })
    .click();
  const failed = mateRow.getByTestId("task-confirm-failed");
  await expect(failed).toContainText(
    "The work was not confirmed. Only this project's team can post this. If you should be on the team, ask the founder to add you to the project, then try again.",
  );
  await expect(failed).not.toContainText("restricted");
  expect((await taskSteps("confirm")).map((e) => tagOf(e, "task"))).toEqual([
    webTaskId,
  ]);

  // (Only the founder is offered Post update or the goal's buttons, and the server never refuses the founder those,
  // so no screen can be made to show the sentence for a refused update or goal against a real server.)
  await mateRow.getByRole("button", { name: "Not yet" }).click();

  // A stranger with only a socket: each family of record is refused with the server's own reason.
  const say = (extra: string[][], content: Record<string, unknown> = {}) =>
    publishAs(stranger, {
      kind: 47003,
      content: JSON.stringify({ title: "x", body: "y", ...content }),
      tags: [["a", coord], ...extra],
    });
  const NOT_FOUNDER = "restricted: only this project's founder can post this";
  const NOT_TEAM = "restricted: only this project's team can post this";
  const NOT_HELPER =
    "restricted: only the helper this task names can post this";
  const refused = async (answer: ReturnType<typeof say>, reason: string) => {
    const got = await answer;
    expect({ accepted: got.accepted, reason: got.reason }).toEqual({
      accepted: false,
      reason,
    });
  };
  await refused(
    say([
      ["goal", "g9"],
      ["goal-level", "primary"],
      ["goal-text", "Mine now"],
      ["goal-how", "I say so"],
    ]),
    NOT_FOUNDER,
  );
  await refused(say([["update-kind", "weekly"]]), NOT_TEAM);
  await refused(
    say([
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", stranger.pubkey],
      ["task-helper", stranger.pubkey],
      ["task-what", "Pay me"],
      ["task-done", "You paid"],
    ]),
    NOT_TEAM,
  );
  const step = (part: string) => [
    ["l", "creaton-task"],
    ["task-part", part],
    ["e", cliTaskId],
    ["task", cliTaskId],
  ];
  await refused(say(step("confirm")), NOT_TEAM);
  // A helper's step from the wrong account: the stranger, and the other task's helper.
  await refused(say(step("accept")), NOT_HELPER);
  const wrongHelper = await publishAs(helper, {
    kind: 47003,
    content: JSON.stringify({ title: "evidence", body: "mine" }),
    tags: [["a", coord], ...step("evidence")],
  });
  expect(wrongHelper.reason).toBe(NOT_HELPER);
  // A project that is not on this server.
  const nowhere = await publishAs(stranger, {
    kind: 47003,
    content: "{}",
    tags: [
      ["a", `37001:${stranger.pubkey}:no-such-project`],
      ["update-kind", "weekly"],
    ],
  });
  expect(nowhere.reason).toBe(
    "invalid: this record names a project that is not on this server",
  );
  // A removal cannot be removed.
  const [removal] = await readAs(stranger, {
    kinds: [5],
    authors: [helper.pubkey],
  });
  const undo = await publishAs(helper, {
    kind: 5,
    content: "",
    tags: [
      ["e", removal.id],
      ["k", "5"],
    ],
  });
  expect(undo.accepted).toBe(false);
  expect(undo.reason).toContain("a deletion cannot be deleted");
  // None of it was stored.
  expect(
    (await readAs(stranger, { kinds: [47003], authors: [stranger.pubkey] }))
      .length,
  ).toBe(0);

  // Back on the team, the second member confirms; the command line and the helper's profile both show it.
  await setTeam([mate]);
  await matePage.goto(projectPath);
  await mateRow.getByRole("button", { name: "Confirm it's done" }).click();
  await mateRow
    .getByTestId("task-confirm-box")
    .getByRole("button", { name: "Yes, confirm" })
    .click();
  await expect(
    matePage.getByTestId("project-tasks").getByTestId("tasks-said"),
  ).toHaveText("You confirmed this work.");
  const after = await buzz(cliHelper, [...tasks, "list", ...at]);
  expect(
    (after.json as Listed).tasks.find((t) => t.task_id === cliTaskId),
  ).toMatchObject({ state: "confirmed" });
  await expect(record(matePage).getByTestId("record-work-totals")).toHaveText(
    "2 pieces of work accepted",
  );
  await matePage.goto(`/u/${cliHelper.pubkey}`);
  await matePage.getByRole("tab", { name: "Record" }).click();
  await expect(
    matePage.getByTestId("track-record").getByTestId("track-record-accepted"),
  ).toHaveText("1 piece of work accepted, on 1 project, confirmed by 1 person");
});

test("7. a project's records are still read when more than 500 newer records of the same kind belong to other projects", async () => {
  test.setTimeout(240_000);
  // Another project, and 620 records about it, all newer than everything this project has.
  const other = newAccount(`Olive ${RUN}`);
  const made = await publishAs(other, {
    kind: 37001,
    content: JSON.stringify({ pitch: "Noise.", stage: "draft" }),
    tags: [
      ["d", `noise-${RUN}`],
      ["name", `Noise ${RUN}`],
      ["t", "dao-launchpad"],
    ],
  });
  expect(made.reason).toBe("");
  const otherCoord = `37001:${other.pubkey}:noise-${RUN}`;
  const before = await readAs(stranger, {
    kinds: [47003],
    "#a": [coord],
    limit: 500,
  });
  // Four writers, 155 records each: the server's per-person limit (600 writes a minute here) stays as it is.
  const noise = (writer: number) =>
    Array.from({ length: 155 }, (_, i) => ({
      kind: 47003,
      // Evidence for on-chain work is the one plain record the server still takes from anyone; a plain update
      // from outside the team is refused (flow 6), so it cannot be the noise here.
      content: JSON.stringify({ claim: { title: `Noise ${writer}.${i}` } }),
      tags: [["a", otherCoord]],
    }));
  for (const writer of [0, 1, 2, 3]) {
    const seeded = await publishManyAs(
      newAccount(`Writer ${writer}`),
      noise(writer),
    );
    expect(seeded).toEqual({ accepted: 155, firstRefusal: null });
  }

  // The unscoped page is full of the other project; the scoped read still returns every one of this project's.
  const newest = await readAs(stranger, { kinds: [47003], limit: 500 });
  expect(newest).toHaveLength(500);
  expect(newest.every((e) => tagOf(e, "a") === otherCoord)).toBe(true);
  const scoped = await readAs(stranger, {
    kinds: [47003],
    "#a": [coord],
    limit: 500,
  });
  expect(scoped.map((e) => e.id).sort()).toEqual(
    before.map((e) => e.id).sort(),
  );
  expect(scoped.length).toBeGreaterThan(10);

  // And the page built on that read still shows the goal, the totals and the accepted work.
  await helperPage.goto(projectPath);
  await expect(helperPage.getByTestId("goal-text")).toHaveText(
    "A first version five people use",
  );
  await expect(
    record(helperPage).getByTestId("record-promise-totals"),
  ).toHaveText("1 kept, 1 missed, 1 changed");
  await expect(record(helperPage).getByTestId("record-work-totals")).toHaveText(
    "2 pieces of work accepted",
  );
  await expect(
    record(helperPage).getByTestId("record-totals-unknown"),
  ).toHaveCount(0);
  const listed = await buzz(cliHelper, [
    "launchpad",
    "tasks",
    "list",
    SLUG,
    "--author",
    founder.pubkey,
  ]);
  expect(listed.json).toMatchObject({
    complete: { help_requests: true, tasks: true },
  });
  expect(
    (listed.json as { tasks: Array<{ state: string }> }).tasks.map(
      (t) => t.state,
    ),
  ).toEqual(["confirmed", "confirmed"]);
});

test("8. boards made inside the project, Home's Boards tab, a private bookmark, a reply's page on two connections, and the side panel", async () => {
  test.setTimeout(240_000);

  // The founder makes the project's two boards from its Boards tab; they are still there after a reload, for anyone.
  await founderPage.goto(`${projectPath}&tab=boards`);
  await expect(founderPage.getByTestId("project-boards-empty")).toHaveText(
    "This project has no boards yet.",
  );
  await founderPage.getByTestId("project-boards-add").click();
  const names = (page: Page) =>
    page.getByTestId("project-boards-list").getByTestId("project-board-name");
  await expect(names(founderPage)).toHaveText(["supporters", "founders"]);
  await expect(founderPage.getByTestId("project-boards-add")).toHaveCount(0);
  await helperPage.goto(projectPath);
  await helperPage.getByRole("tab", { name: "Boards" }).click();
  // The founders board is private: someone who was not added to it is not shown it.
  await expect(names(helperPage)).toHaveText(["supporters"]);

  // Home's Boards tab lists them under the project's name, and the name opens the project.
  await helperPage.goto("/?tab=boards");
  const group = helperPage
    .locator('[data-testid^="board-directory-group-"]')
    .filter({ hasText: PROJECT_NAME });
  await expect(group.getByRole("heading")).toHaveText(PROJECT_NAME);
  await expect(group.getByTestId("board-directory-name")).toHaveText([
    "supporters",
  ]);
  await group.getByTestId("board-directory-project-link").click();
  await expect(helperPage).toHaveURL(
    new RegExp(`/launchpad/${SLUG}\\?author=${founder.pubkey}`),
  );

  // A post, a reply, and a reply to the reply.
  const rootText = `Where should we meet? ${RUN}`;
  await founderPage.goto("/social");
  await founderPage.getByTestId("social-composer-input").fill(rootText);
  await founderPage.getByTestId("social-composer-submit").click();
  const post = (page: Page, text: string) =>
    page.getByTestId("social-post").filter({ hasText: text }).first();
  await expect(post(founderPage, rootText)).toBeVisible();
  const [root] = await readAs(stranger, {
    kinds: [1],
    authors: [founder.pubkey],
  });
  expect(root.content).toBe(rootText);
  await helperPage.goto(`/social/post/${root.id}`);
  await expect(post(helperPage, rootText)).toBeVisible();
  await helperPage
    .getByTestId("social-reply-composer-input")
    .fill(`The park ${RUN}`);
  await helperPage.getByTestId("social-reply-composer-submit").click();
  await expect(post(helperPage, `The park ${RUN}`)).toBeVisible();
  const [reply] = await readAs(stranger, {
    kinds: [1],
    authors: [helper.pubkey],
    "#e": [root.id],
  });
  await matePage.goto(`/social/post/${reply.id}`);
  await matePage
    .getByTestId("social-reply-composer-input")
    .fill(`Which park? ${RUN}`);
  await matePage.getByTestId("social-reply-composer-submit").click();
  await expect(post(matePage, `Which park? ${RUN}`)).toBeVisible();
  const [deep] = await readAs(stranger, {
    kinds: [1],
    authors: [mate.pubkey],
    "#e": [reply.id],
  });
  expect(deep.tags).toEqual(
    expect.arrayContaining([
      ["e", root.id, "", "root"],
      ["e", reply.id, "", "reply"],
    ]),
  );

  // The helper saves the founder's post: nothing public says which, and it is listed after a reload.
  await helperPage.goto("/social");
  const card = post(helperPage, rootText);
  await card.getByTestId("social-bookmark").click();
  await expect(card.getByTestId("social-bookmark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(
      async () =>
        (await readAs(helper, { kinds: [10003], authors: [helper.pubkey] }))
          .length,
    )
    .toBe(1);
  const [saved] = await readAs(helper, {
    kinds: [10003],
    authors: [helper.pubkey],
  });
  expect(JSON.stringify(saved.tags)).not.toContain(root.id);
  expect(saved.content).not.toContain(root.id);
  await helperPage.goto("/social/bookmarks");
  await expect(post(helperPage, rootText)).toBeVisible();

  // The deep reply's own page: the notes above it and the page's reads for the thread, on two connections at most.
  const mine = [deep.id, reply.id, root.id];
  const threadSockets = new Set<number>();
  const threadReads: string[] = [];
  let socket = 0;
  helperPage.on("websocket", (ws) => {
    const number = ++socket;
    ws.on("framesent", (frame) => {
      let sent: unknown;
      try {
        sent = JSON.parse(String(frame.payload));
      } catch {
        return;
      }
      if (!Array.isArray(sent) || sent[0] !== "REQ") return;
      const threadRead = (sent.slice(2) as Record<string, unknown>[]).some(
        (f) => {
          if (JSON.stringify(f.kinds) !== "[1]") return false;
          const ids = f.ids;
          const replies = f["#e"];
          // A read by id alone that does not name this note is not counted: Home's side panel reads its popular posts
          // that way, and on this server those are the same two posts that stand above the reply.
          return (
            (Array.isArray(ids) && ids.includes(deep.id)) ||
            (Array.isArray(replies) && mine.some((id) => replies.includes(id)))
          );
        },
      );
      if (threadRead) {
        threadSockets.add(number);
        threadReads.push(JSON.stringify(sent.slice(2)));
      }
    });
  });
  await helperPage.goto(`/social/post/${deep.id}`);
  await expect(helperPage.getByTestId("social-thread-focus")).toContainText(
    `Which park? ${RUN}`,
  );
  await expect(helperPage.getByText(rootText).first()).toBeVisible();
  await expect(helperPage.getByText(`The park ${RUN}`).first()).toBeVisible();
  expect(
    threadSockets.size,
    "connections that read the thread",
  ).toBeGreaterThan(0);
  expect(
    threadSockets.size,
    `connections that read the thread: ${threadReads.join(" | ")}`,
  ).toBeLessThanOrEqual(2);

  // Home's side panel, from real data: the projects started with the short form are listed (the newest few), and the
  // post is there under Trending posts.
  await helperPage.goto("/");
  await expect(helperPage.getByTestId("social-rail-projects")).toBeVisible();
  await expect(
    helperPage.getByTestId("social-rail-projects-empty"),
  ).toHaveCount(0);
  await expect(helperPage.getByTestId("social-rail-posts")).toContainText(
    "Where should we meet?",
  );
  expect(
    await helperPage.locator('[data-testid^="social-rail-block-"]').count(),
  ).toBeGreaterThanOrEqual(3);
  await shot(helperPage, "08-home");

  // Last, so the founder's own update stays the project's newest for the steps above.
  await teamMemberPostsAnUpdate();
  await theRecordIsReadOnHomeAndOnYourProjects();
});

test("9. the scoreboard, Work, the public scorecard, a cheer and the note after an update, all from the real records", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // A visitor with no account opens the project's scorecard at its short address.
  const visitor = await ownBrowserPage(browser);
  await visitor.goto(`/p/${SLUG}-${founder.pubkey.slice(0, 16)}`);
  const scorecard = visitor.getByTestId("scorecard");
  await expect(scorecard.getByRole("heading", { level: 1 })).toHaveText(
    PROJECT_NAME,
  );
  // Test 3 made three promises and answered each: the totals are stated, from the founder's own records.
  await expect(scorecard.getByTestId("scorecard-kept")).toHaveText(
    /^\d+ of \d+$/,
  );
  await expect(scorecard.getByTestId("scorecard-streak")).not.toHaveText(
    "Not known",
  );
  await expect(
    scorecard.getByTestId("scorecard-promise").first(),
  ).toBeVisible();
  await expect(scorecard.getByTestId("scorecard-update")).toContainText(
    `From the team ${RUN}`,
  );
  await expect(scorecard.getByTestId("scorecard-team")).toContainText(
    FOUNDER_NAME,
  );
  await expect(scorecard.getByTestId("scorecard-failed")).toHaveCount(0);
  await expect(visitor).toHaveTitle(`${PROJECT_NAME} on Creaton`);
  await expect(scorecard).not.toContainText(/\$|earn/i);
  await shot(visitor, "10-scorecard");
  // The same project id under another account's address opens nothing.
  await visitor.goto(`/p/${SLUG}-${stranger.pubkey.slice(0, 16)}`);
  await expect(visitor.getByTestId("scorecard-missing")).toBeVisible();

  // The Projects scoreboard, signed out: the project is on "New" with its record, and on "Moving now" (it posted
  // today), from one read by who signed.
  await visitor.goto("/discover");
  const board = visitor.getByTestId("project-board");
  await board.getByTestId("project-board-tab-new").click();
  const row = board
    .getByTestId("project-board-row")
    .filter({ hasText: PROJECT_NAME });
  await expect(row.getByTestId("project-board-facts")).toContainText(
    /promises? kept/,
  );
  await board.getByTestId("project-board-tab-moving").click();
  await expect(row).toHaveCount(1);
  await expect(board.getByTestId("project-board-failed")).toHaveCount(0);
  await shot(visitor, "11-scoreboard");

  // Work: the page reads for a visitor, and the helper's own tasks are there step by step. The piece the team
  // confirmed in test 5 has all four steps.
  await visitor.goto("/work");
  await expect(visitor.getByTestId("work-page")).toBeVisible();
  await expect(visitor.getByTestId("work-open-failed")).toHaveCount(0);
  await helperPage.goto("/work");
  const confirmed = helperPage.locator(
    '[data-testid="work-yours-item"][data-state="confirmed"]',
  );
  await expect(confirmed).toHaveCount(1);
  await expect(confirmed).toContainText(PROJECT_NAME);
  await expect(confirmed.locator('[data-step][data-done="true"]')).toHaveCount(
    4,
  );
  await expect(helperPage.getByTestId("work-yours-failed")).toHaveCount(0);
  await expect(helperPage.getByTestId("work-waiting-failed")).toHaveCount(0);
  await shot(helperPage, "12-work");

  // A cheer on accepted work: one tap, stored by the server as that person's reaction, counted once.
  await matePage.goto("/?tab=updates");
  const accepted = matePage
    .getByTestId("record-feed")
    .getByTestId("record-card")
    .filter({ hasText: "Work accepted" })
    .filter({ hasText: cliHelper.name });
  const cheer = accepted.getByTestId("record-card-cheer");
  await cheer.click();
  await expect(cheer).toContainText("Cheered");
  await expect(accepted.getByTestId("record-card-cheers")).toHaveText("1");
  await expect
    .poll(
      async () =>
        (await readAs(stranger, { kinds: [7], authors: [mate.pubkey] })).length,
    )
    .toBe(1);
  await matePage.reload();
  await expect(cheer).toContainText("Cheered");
  await expect(cheer).toBeDisabled();

  // The founder posts once more: the server takes it, and the page ends on the note with the record to share.
  await founderPage.goto(projectPath);
  await founderPage.getByRole("button", { name: "Post update" }).click();
  const dialog = founderPage.getByRole("dialog", { name: "Post update" });
  await dialog.getByLabel("Title").fill(`Closing the week ${RUN}`);
  await dialog
    .getByLabel("What's next")
    .fill("One more thing\nAnd another\nA third\nA fourth");
  await expect(dialog.getByTestId("update-next-too-many")).toBeVisible();
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  const note = founderPage.getByTestId("update-posted");
  await expect(note.getByTestId("update-posted-streak")).toBeVisible();
  const stored = (await projectRecords("promise")).find((e) =>
    e.content.includes(`Closing the week ${RUN}`),
  );
  expect(stored, "the update is on the server").toBeTruthy();
  expect(stored?.tags.filter((t) => t[0] === "promise")).toHaveLength(3);
  await note.getByTestId("share-record").click();
  // Copied, or (where the browser will not copy) the words shown to copy by hand: either way the link is the
  // scorecard's.
  await expect
    .poll(async () => {
      const status = await note.getByTestId("share-record-status").innerText();
      const shown = await note.getByTestId("share-record-words").count();
      return status.includes("Copied") || shown === 1;
    })
    .toBe(true);
  await shot(founderPage, "13-update-posted");
});

test("10. the next update starts from last time's promises, Home shows it live, Work lists its request and takes an offer, and a newcomer is welcomed", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const PROOF = `Someone to proofread the install guide ${RUN}.`;
  const TITLE = `Week three ${RUN}`;

  // Home is open on the helper's side before anything is posted.
  await helperPage.goto("/?tab=updates");
  const feed = helperPage.getByTestId("record-feed");
  await expect(feed.getByTestId("record-card").first()).toBeVisible();
  await expect(
    feed.getByTestId("record-card").filter({ hasText: TITLE }),
  ).toHaveCount(0);

  // The founder opens the update dialog: it starts from what the last updates promised, each asking for an answer.
  await founderPage.goto(projectPath);
  await founderPage.getByRole("button", { name: "Post update" }).click();
  const dialog = founderPage.getByRole("dialog", { name: "Post update" });
  const promise = (text: string) => dialog.getByRole("group", { name: text });
  for (const said of ["One more thing", "And another", "A third"])
    await expect(promise(said)).toBeVisible();
  await expect(dialog).toContainText("What you said last time");
  await promise("One more thing")
    .getByRole("radio", { name: "Done", exact: true })
    .check();
  await promise("And another").getByRole("radio", { name: "Not done" }).check();
  await dialog.getByLabel("Short note for: And another").fill("Next week");
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog
    .getByLabel("What happened this week")
    .fill("Finished the first of the three.");
  await dialog.getByLabel("What's next").fill("Proofread the install guide");
  await dialog.getByLabel("Help needed (optional)").fill(PROOF);
  await dialog.getByRole("radio", { name: "Small" }).check();
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(founderPage.getByTestId("update-posted")).toBeVisible();
  const posted = (await projectRecords("help-needed")).find(
    (e) => tagOf(e, "help-needed") === PROOF,
  );
  expect(posted, "the update with its request is on the server").toBeTruthy();
  expect(
    posted?.tags.filter((t) => t[0] === "promise-mark").map((t) => t[2]),
  ).toEqual(["done", "not-done"]);

  // Home, still open, finds it on its next look (every 30 seconds): it waits behind "1 new record" so nothing moves
  // under the reader, and slides in when the pill is pressed.
  const pill = feed.getByTestId("record-feed-new-pill");
  await expect(pill).toHaveText("1 new record", { timeout: 60_000 });
  await expect(
    feed.getByTestId("record-card").filter({ hasText: TITLE }),
  ).toHaveCount(0);
  await pill.click();
  const fresh = feed.getByTestId("record-card").filter({ hasText: TITLE });
  await expect(fresh).toHaveCount(1);
  await expect(fresh).toContainText(PROOF);
  await expect(feed.getByTestId("record-feed-failed")).toHaveCount(0);

  // Work lists the request with its size and one tap to offer; the tap lands on the request itself.
  await helperPage.goto("/work");
  const item = helperPage
    .getByTestId("work-open-item")
    .filter({ hasText: PROJECT_NAME });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(PROOF);
  await expect(item).toContainText("Small");
  await item.getByTestId("work-open-do").click();
  await expect(helperPage).toHaveURL(/tab=updates/);
  const request = helperPage
    .getByTestId("help-request")
    .filter({ hasText: PROOF });
  await expect(request).toBeVisible();
  await request.getByRole("button", { name: "I can help" }).click();
  const box = request.getByTestId("help-offer-box");
  await box
    .getByLabel("Add a short note (optional)")
    .fill("I have an hour on Thursday.");
  await box.getByRole("button", { name: "Send offer" }).click();
  await expect(request.getByTestId("help-my-offer")).toContainText(
    "I have an hour on Thursday.",
  );
  // The server has it: the command line reads the request as already offered on by this helper.
  const listed = await buzz(helper, [
    "launchpad",
    "tasks",
    "list",
    SLUG,
    "--author",
    founder.pubkey,
  ]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.json).toMatchObject({
    help_requests: expect.arrayContaining([
      expect.objectContaining({ text: PROOF, offered_by_me: true }),
    ]),
  });
  await shot(helperPage, "14-work-offer");

  // The scorecard reads for a visitor with no account: the open request, and the answers just given.
  const visitor = await ownBrowserPage(browser);
  await visitor.goto(`/p/${SLUG}-${founder.pubkey.slice(0, 16)}`);
  const scorecard = visitor.getByTestId("scorecard");
  await expect(scorecard.getByTestId("scorecard-open-help")).toContainText(
    "open request",
  );
  await expect(scorecard.getByTestId("scorecard-kept")).toHaveText(
    /^\d+ of \d+$/,
  );
  await expect(scorecard.getByTestId("scorecard-follow")).toBeVisible();
  await expect(scorecard).not.toContainText(/\$|earn/i);

  // A newcomer: a new account tied to no project is welcomed once, with three ways in; following a project from
  // the welcome is stored by the server as that account's own follow.
  const newcomer = await ownBrowserPage(browser);
  await newcomer.goto("/");
  await newcomer.getByTestId("create-identity-cta").first().click();
  await newcomer.getByTestId("onboarding-name").fill(`Nia ${RUN}`);
  await newcomer.getByTestId("onboarding-create").click();
  await expect(newcomer.getByTestId("user-chip")).toBeVisible();
  const [sealed, wrap] = await newcomer.evaluate(() => [
    window.localStorage.getItem("buzz.identity.nsec") ?? "",
    window.localStorage.getItem("buzz.identity.wrap") ?? "",
  ]);
  const nia = accountFromKey(nip49Decrypt(sealed, wrap), `Nia ${RUN}`);
  await newcomer.goto("/");
  const welcome = newcomer.getByTestId("newcomer-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome.getByTestId("welcome-start")).toHaveAttribute(
    "href",
    "/start",
  );
  await expect(welcome.getByTestId("welcome-work")).toHaveAttribute(
    "href",
    "/work",
  );
  await expect(welcome).not.toContainText(/\$|price|earn|trending|hot/i);
  await welcome.getByTestId("welcome-follow-some").click();
  const picks = welcome.getByTestId("welcome-follow-item");
  await expect(picks.first()).toBeVisible();
  expect(await picks.count()).toBeLessThanOrEqual(5);
  await picks.first().getByTestId("welcome-follow").click();
  await expect
    .poll(
      async () =>
        (await readAs(stranger, { kinds: [10003], authors: [nia.pubkey] }))
          .length,
    )
    .toBe(1);
  await welcome.getByTestId("welcome-done").click();
  await expect(welcome).toHaveCount(0);
  await shot(newcomer, "15-newcomer");
});
