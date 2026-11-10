import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  newest,
  now,
  openAs,
  projectPath,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * A project's team, in the browser: the founder adds a person from the Team section (and reads, before adding, that
 * the server lets them act at once); everyone sees them as added but not yet a yes; the person says yes with a record
 * of their own, posts an update (with no promises: those are the founder's), and confirms work the founder could not
 * confirm alone; the founder removes them and the page says they were on the team until that day. Around it: a save
 * whose answer is lost, a "no", another save that must not drop the team, and a server that refuses.
 *
 * The mock server checks who may sign what, as the real one does, so an update with a promise from a team member, or
 * a confirmation from someone not on the team, would be refused here too.
 */

const FOUNDER_KEY = "c1".repeat(32);
const MEMBER_KEY = "c2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const MEMBER = pubkeyOf(MEMBER_KEY);
const STRANGER = pubkeyOf("c3".repeat(32));
const COORD = coordOf(FOUNDER, "nebula");
const PROJECT = projectPath(FOUNDER, "nebula");

const profile = (pubkey: string, name: string) =>
  event(0, pubkey, { name, display_name: name }, [], now() - 30 * DAY);

function seedWorld(relay: Relay, tags: string[][] = []) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(MEMBER, "Max Mate"));
  relay.seed(profile(STRANGER, "Sam Stranger"));
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - 30 * DAY, { tags }),
  );
}

/** Work the founder did themselves and handed in: nobody on a team of one can confirm it. */
function seedFoundersOwnWork(relay: Relay) {
  const task = event(
    47003,
    FOUNDER,
    { title: "Task", body: "Write the changelog." },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["p", FOUNDER],
      ["task-helper", FOUNDER],
      ["task-what", "Write the changelog."],
      ["task-done", "The changelog is on the site."],
      ["task-size", "small"],
    ],
    now() - 3600,
  );
  relay.seed(task);
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "evidence", body: "It is live.", note: "It is live." },
      [
        ["a", COORD],
        ["l", "creaton-task"],
        ["task-part", "evidence"],
        ["e", task.id],
        ["task", task.id],
      ],
      now() - 600,
    ),
  );
}

const teamTagsOf = (relay: Relay) =>
  newest(relay, 37001, FOUNDER)?.tags.filter((t) => t[0] === "team") ?? [];
const answers = (relay: Relay, pubkey: string) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === pubkey &&
      e.tags.some((t) => t[0] === "team-answer"),
  );

async function addMember(page: import("@playwright/test").Page) {
  await page.getByTestId("team-add").click();
  await page.getByTestId("team-add-search").fill(MEMBER);
  await page.getByTestId("person-search-result").first().click();
  await expect(page.getByTestId("team-add-picked")).toContainText(
    "Add Max Mate to the team?",
  );
  await page.getByTestId("team-add-confirm").click();
}

test("the founder adds a person, they say yes, post an update and confirm work; then they are removed and it shows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  seedFoundersOwnWork(relay);
  // A stranger signs a "yes" of their own: it names no invitation the founder made, and puts them on nothing.
  relay.seed(
    event(
      47003,
      STRANGER,
      { title: "Joined the team", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", ""],
      ],
      now() - DAY,
    ),
  );
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);

  // Alone, the founder's own work cannot be confirmed.
  const task = page.getByTestId("project-tasks").getByTestId("task");
  await expect(task.getByTestId("task-cannot-confirm")).toContainText(
    "Nobody else is on this project's team yet",
  );

  // The dialog says exactly what the server does before anyone is added.
  const team = page.getByTestId("project-team");
  await team.getByTestId("team-add").click();
  await expect(page.getByTestId("team-add-warning")).toContainText(
    "They can act for this project as soon as you add them.",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Goals and promises stay yours alone.",
  );
  await expectAccessible(page, "add a person to the team");
  await page.getByTestId("team-add-search").fill(MEMBER);
  await page.getByTestId("person-search-result").first().click();
  await page.getByTestId("team-add-confirm").click();

  // Shown at once, and saved on the founder's own record with the rest of it kept.
  const invited = team.getByTestId("team-invited-member");
  await expect(invited).toContainText("Max Mate");
  await expect.poll(() => teamTagsOf(relay).length).toBe(1);
  const saved = newest(relay, 37001, FOUNDER);
  const [, who, role, invite] = teamTagsOf(relay)[0];
  expect(who).toBe(MEMBER);
  expect(role).toBe("member");
  expect(invite).toMatch(/^[a-z0-9]{12}$/);
  expect(saved?.tags).toContainEqual(["p", MEMBER]);
  expect(saved?.tags).toContainEqual(["name", "Nebula"]);
  expect(saved?.body.pitch).toBe("Nebula, in one sentence.");
  await expect(invited).toContainText(
    "Has not said yes yet. The server already lets them act for this project.",
  );

  // A visitor reads the same: added, not yet a yes, and not listed as team. The stranger is nowhere.
  await openAs(page, null, PROJECT);
  await expect(team.getByTestId("team-invited-member")).toContainText(
    "Has not said yes yet",
  );
  await expect(team.getByTestId("team-member")).toHaveCount(0);
  await expect(team).not.toContainText("Sam Stranger");
  await expect(team.getByTestId("team-add")).toHaveCount(0);

  // The person added finds the invitation in Notifications, and answers on the project's page.
  await openAs(page, MEMBER_KEY, "/social/notifications");
  await expect(page.getByTestId("social-team-invitation")).toContainText(
    "Fay Founder added you to the team of Nebula",
  );
  await page.getByRole("link", { name: /Open Nebula to answer/ }).click();
  await expect(team.getByTestId("team-invitation")).toContainText(
    "Fay Founder added you to this project's team.",
  );
  await expect(page.getByTestId("team-post-update")).toHaveCount(0);
  await team.getByTestId("team-join").click();
  await expect(team.getByTestId("team-answered")).toHaveText(
    "You joined the team.",
  );
  await expect.poll(() => answers(relay, MEMBER).length).toBe(1);
  const yes = answers(relay, MEMBER)[0];
  expect(yes.tags).toContainEqual(["a", COORD]);
  expect(yes.tags).toContainEqual(["team-answer", "yes"]);
  expect(yes.tags).toContainEqual(["team-invite", invite]);
  await expect(team.getByTestId("team-member")).toContainText("Max Mate");
  await expect(team.getByTestId("team-member")).toContainText(
    "Can post updates and check work",
  );
  await expectAccessible(page, "project page with a team");

  // Read back from the server: they are team, and Notifications no longer asks.
  await page.reload();
  await expect(team.getByTestId("team-member")).toContainText("Max Mate");
  await expect(team.getByTestId("team-invitation")).toHaveCount(0);

  // They post an update. It makes no promises: the server takes those from the founder alone.
  await page.getByTestId("team-post-update").click();
  await expect(page.getByTestId("update-as-team")).toContainText(
    "It makes no promises",
  );
  await page.getByLabel("Title").fill("Docs are up");
  await page.getByLabel("What's next").fill("Write the install guide");
  await page.getByRole("button", { name: "Publish update" }).click();
  const posted = () =>
    relay.events.filter(
      (e) =>
        e.kind === 47003 &&
        e.pubkey === MEMBER &&
        e.tags.some((t) => t[0] === "update-part"),
    );
  await expect.poll(() => posted().length).toBe(1);
  expect(posted()[0].tags.some((t) => t[0] === "promise")).toBe(false);
  expect(posted()[0].tags).toContainEqual([
    "update-part",
    "next",
    "Write the install guide",
  ]);

  // They confirm the work the founder could not confirm alone.
  await task.getByRole("button", { name: "Confirm it's done" }).click();
  await task.getByRole("button", { name: "Yes, confirm" }).click();
  await expect(
    page.getByTestId("project-record").getByTestId("record-work-accepted"),
  ).toContainText("Checked by Max Mate");

  // The founder removes them. The record says they left and when, and a visitor reads it.
  await openAs(page, FOUNDER_KEY, PROJECT);
  await team.getByTestId("team-remove").click();
  await expect(team).toContainText("Remove Max Mate?");
  await team.getByTestId("team-remove-confirm").click();
  await expect(team.getByTestId("team-member")).toHaveCount(0);
  await expect.poll(() => teamTagsOf(relay).length).toBe(0);
  const after = newest(relay, 37001, FOUNDER);
  const left = after?.tags.find((t) => t[0] === "team-left");
  expect(left?.[1]).toBe(MEMBER);
  expect(Number(left?.[2])).toBeGreaterThan(now() - 120);
  expect(after?.tags.some((t) => t[0] === "p" && t[1] === MEMBER)).toBe(false);
  await openAs(page, null, PROJECT);
  await expect(team.getByTestId("team-former")).toContainText(
    "Max Mate was on the team until",
  );
  await expect(team.getByTestId("team-member")).toHaveCount(0);
  // Off the team, the app offers them nothing to post.
  await openAs(page, MEMBER_KEY, PROJECT);
  await expect(team.getByTestId("team-former")).toBeVisible();
  await expect(page.getByTestId("team-post-update")).toHaveCount(0);
});

test("an add whose answer is lost says so, and pressing again invites nobody twice", async ({
  page,
}) => {
  test.setTimeout(90_000);
  let lose = true;
  const relay = createMockRelay({
    applyDeletions: true,
    loseAnswer: (e) => {
      if (!lose || e.kind !== 37001) return false;
      lose = false;
      return true;
    },
  });
  seedWorld(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  await addMember(page);
  // The server took the record and never said so. Whatever the page says, the person is on the record once.
  await expect
    .poll(() => teamTagsOf(relay).length, { timeout: 30_000 })
    .toBe(1);
  const firstInvite = teamTagsOf(relay)[0][3];
  // The record is read again after the send, so the person shows as added and the founder is not told to add again
  // for nothing; if they do press again, the record already names the person and nothing is sent.
  await expect(team.getByTestId("team-invited-member")).toContainText(
    "Max Mate",
    { timeout: 30_000 },
  );
  const before = relay.events.filter((e) => e.kind === 37001).length;
  await page.getByTestId("team-add").click();
  await page.getByTestId("team-add-search").fill(MEMBER);
  await page.getByTestId("person-search-result").first().click();
  await expect(page.getByTestId("team-add-picked")).toContainText(
    "Max Mate is already on the team.",
  );
  await expect(page.getByTestId("team-add-confirm")).toBeDisabled();
  expect(relay.events.filter((e) => e.kind === 37001).length).toBe(before);
  expect(teamTagsOf(relay)).toHaveLength(1);
  expect(teamTagsOf(relay)[0][3]).toBe(firstInvite);
});

test("a no is shown to everyone, and the person is not listed as team", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay, [
    ["team", MEMBER, "member", "inv1"],
    ["p", MEMBER],
  ]);
  await install(page, relay, MEMBER_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  await team.getByTestId("team-decline").click();
  await expect(team.getByTestId("team-answered")).toContainText("You said no.");
  await expect.poll(() => answers(relay, MEMBER).length).toBe(1);
  expect(answers(relay, MEMBER)[0].tags).toContainEqual(["team-answer", "no"]);
  await openAs(page, null, PROJECT);
  const row = team.getByTestId("team-invited-member");
  await expect(row).toHaveAttribute("data-state", "declined");
  await expect(row).toContainText(
    "Said no. The server still lets them act for this project until the founder removes them.",
  );
  await expect(team.getByTestId("team-member")).toHaveCount(0);
});

test("a change the server refuses is said, and the team is shown as it is", async ({
  page,
}) => {
  const relay = createMockRelay({
    applyDeletions: true,
    refuse: (e) => (e.kind === 37001 ? "error: database error: down" : null),
  });
  seedWorld(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  await addMember(page);
  await expect(team.getByTestId("team-failed")).toContainText(
    "Max Mate was not added",
  );
  await expect(team.getByTestId("team-invited-member")).toHaveCount(0);
  expect(teamTagsOf(relay)).toHaveLength(0);
});

test("another save of the project record keeps the team", async ({ page }) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay, [
    ["team", MEMBER, "member", "inv1"],
    ["p", MEMBER],
    ["team-left", STRANGER, "1700000000"],
  ]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("project-listing-toggle").click();
  await expect
    .poll(() => newest(relay, 37001, FOUNDER)?.body.listing)
    .toBe("unlisted");
  const saved = newest(relay, 37001, FOUNDER);
  expect(saved?.tags).toContainEqual(["team", MEMBER, "member", "inv1"]);
  expect(saved?.tags).toContainEqual(["p", MEMBER]);
  expect(saved?.tags).toContainEqual(["team-left", STRANGER, "1700000000"]);
});

test("at 390px the Team section and its dialog fit with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay, [
    ["team", MEMBER, "member", "inv1"],
    ["p", MEMBER],
  ]);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const fits = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await expect(page.getByTestId("team-invited-member")).toBeVisible();
  expect(await fits()).toBe(true);
  await page.getByTestId("team-remove").click();
  expect(await fits()).toBe(true);
  await page.getByTestId("team-add").click();
  await expect(page.getByTestId("team-add-warning")).toBeVisible();
  expect(await fits()).toBe(true);
});
