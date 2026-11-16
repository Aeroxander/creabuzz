import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import {
  ACCEPT_PATH_BUDGET,
  JOIN_PATH_BUDGET,
  PressCounter,
} from "../helpers/press-counter";
import { createMockRelay, projectRecordRefusal } from "./mock-relay";
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
 * Joining a project from its link: a signed-in stranger presses "Ask to join" once and is told the founder knows; the
 * founder sees the ask in the Team card and in Notifications and presses Accept once; the person is then on the team,
 * already said yes, with nothing more to press. Signed out, the button opens the sign-up dialog. The mock server holds
 * the same rules as the real one: a stranger may ask and may do nothing else, a person on the team need not ask, and
 * an ask is capped per project.
 */

const FOUNDER_KEY = "c1".repeat(32);
const STRANGER_KEY = "c2".repeat(32);
const MATE_KEY = "c3".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const STRANGER = pubkeyOf(STRANGER_KEY);
const MATE = pubkeyOf(MATE_KEY);
const COORD = coordOf(FOUNDER, "nebula");
const PROJECT = projectPath(FOUNDER, "nebula");
const CARD = `/p/nebula-${FOUNDER.slice(0, 16)}`;

const profile = (pubkey: string, name: string) =>
  event(0, pubkey, { name, display_name: name }, [], now() - 30 * DAY);

function seedWorld(relay: Relay) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(STRANGER, "Sam Stranger"));
  relay.seed(profile(MATE, "Max Mate"));
  relay.seed(
    projectRecord(FOUNDER, "nebula", "Nebula", now() - 30 * DAY, {
      tags: [
        ["team", MATE, "member"],
        ["team-invite", MATE, "mate1"],
        ["p", MATE],
      ],
    }),
  );
  relay.seed(
    event(
      47003,
      MATE,
      "",
      [
        ["a", COORD],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "mate1"],
      ],
      now() - 20 * DAY,
    ),
  );
}

const asksBy = (relay: Relay, pubkey: string) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === pubkey &&
      e.tags.some((t) => t[0] === "join-ask"),
  );

/** The ask as the app signs it, for the rules the mock server holds. */
const askOf = (who: string, note: string) =>
  event(
    47003,
    who,
    { title: "Asked to join", body: "" },
    [
      ["a", COORD],
      ["l", "creaton-join"],
      ["join-ask", "abc123"],
      ["l", "creaton-team"],
      ["team-answer", "yes"],
      ["team-invite", "abc123"],
      ["p", FOUNDER],
      ["note", note],
    ],
    now(),
  );

const teamTagsOf = (relay: Relay) =>
  newest(relay, 37001, FOUNDER)?.tags.filter((t) => t[0] === "team") ?? [];

async function expectOneGreen(page: Page) {
  const card = page.getByTestId("scorecard");
  await expect(card.getByTestId("join-ask")).toHaveText("Ask to join");
  await expect(card.getByTestId("join-ask")).toHaveClass(/bg-primary/);
  await expect(card.getByTestId("scorecard-follow")).not.toHaveClass(
    /bg-primary/,
  );
}

test("a signed-in stranger on the project's link presses Ask to join once and is told the founder knows, also after a reload", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, STRANGER_KEY);
  await page.goto(CARD);

  const card = page.getByTestId("scorecard");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expectOneGreen(page);
  await expectAccessible(page, "a project's link, with Ask to join");

  const path = new PressCounter();
  await path.press(card.getByTestId("join-ask"), "Ask to join");
  await expect(card.getByTestId("join-asked")).toHaveText(
    "Asked to join. The founder has been told.",
  );
  // Signed in, it is one press and nothing typed: inside the budget, which allows a second for the sign-up dialog.
  expect(path.presses).toBe(1);
  expect(path.presses).toBeLessThanOrEqual(JOIN_PATH_BUDGET.presses);
  expect(path.fields).toBe(JOIN_PATH_BUDGET.fields);
  await expect(card.getByTestId("join-ask")).toHaveCount(0);

  // One signed record, naming the project and the founder, holding the person's own yes to the name it gives.
  const [ask] = asksBy(relay, STRANGER);
  expect(asksBy(relay, STRANGER)).toHaveLength(1);
  const invite = ask.tags.find((t) => t[0] === "join-ask")?.[1] ?? "";
  expect(invite).toMatch(/^[a-z0-9]{12}$/);
  expect(ask.tags).toEqual(
    expect.arrayContaining([
      ["a", COORD],
      ["l", "creaton-join"],
      ["l", "creaton-team"],
      ["team-answer", "yes"],
      ["team-invite", invite],
      ["p", FOUNDER],
    ]),
  );

  // The person's own ask is read back: after a reload it is still said, and there is no button.
  await page.reload();
  await expect(
    page.getByTestId("scorecard").getByTestId("join-asked"),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("join-ask")).toHaveCount(0);
  expect(asksBy(relay, STRANGER)).toHaveLength(1);

  // The project's page says it too, and offers nothing else on the project.
  await page.goto(PROJECT);
  await expect(page.getByTestId("join-asked")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("team-post-update")).toHaveCount(0);
});

test("signed out, Ask to join opens the sign-up dialog and sends nothing, and the person stays on the project's link", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, null);
  await page.goto(CARD);
  const card = page.getByTestId("scorecard");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expectOneGreen(page);
  await card.getByTestId("join-ask").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(
    relay.events.filter((e) => e.kind === 47003 && e.pubkey === STRANGER),
  ).toHaveLength(0);
  await expect(page).toHaveURL(new RegExp(`${CARD}$`));
});

test("the founder sees the ask in the Team card and accepts it in one press, and the person is then on the team with nothing more to press", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, STRANGER_KEY);
  await page.goto(CARD);
  await page.getByTestId("join-ask").click();
  await expect(page.getByTestId("join-asked")).toBeVisible();
  const invite =
    asksBy(relay, STRANGER)[0].tags.find((t) => t[0] === "join-ask")?.[1] ?? "";

  await openAs(page, FOUNDER_KEY, PROJECT);
  const team = page.getByTestId("project-team");
  await expect(team.getByTestId("join-request")).toContainText(
    "Sam Stranger asked to join",
    { timeout: 20_000 },
  );
  await expect(team.getByTestId("join-accept")).toHaveText("Accept");
  await expectAccessible(page, "the Team card with an ask to join");
  const accept = new PressCounter();
  await accept.press(team.getByTestId("join-accept"), "Accept");
  expect(accept.presses).toBe(ACCEPT_PATH_BUDGET.presses);
  expect(accept.fields).toBe(ACCEPT_PATH_BUDGET.fields);

  // The record is saved once with the person on it under the name they gave, the rest of it kept.
  await expect.poll(() => teamTagsOf(relay).length).toBe(2);
  expect(teamTagsOf(relay)).toContainEqual(["team", STRANGER, "member"]);
  const saved = newest(relay, 37001, FOUNDER);
  expect(saved?.tags).toContainEqual(["team-invite", STRANGER, invite]);
  expect(saved?.tags).toContainEqual(["team", MATE, "member"]);
  expect(saved?.tags).toContainEqual(["name", "Nebula"]);
  await expect(team.getByTestId("join-added")).toContainText(
    "Sam Stranger is on the team.",
  );
  await expect(team.getByTestId("join-accept")).toHaveCount(0);

  // The person reads themselves as on the team, already said yes: no invitation to answer, no Ask to join.
  await openAs(page, STRANGER_KEY, PROJECT);
  const theirs = page.getByTestId("project-team");
  await expect(
    theirs.getByTestId("team-member").filter({ hasText: "Sam Stranger" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(theirs.getByTestId("team-invitation")).toHaveCount(0);
  await expect(page.getByTestId("join-ask")).toHaveCount(0);
  await expect(page.getByTestId("join-asked")).toHaveCount(0);
  await expect(page.getByTestId("team-post-update")).toBeVisible();
});

test("the founder sees the ask in Notifications with one Accept", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, STRANGER_KEY);
  await page.goto(CARD);
  await page.getByTestId("join-ask").click();
  await expect(page.getByTestId("join-asked")).toBeVisible();

  await openAs(page, FOUNDER_KEY, "/social/notifications");
  const section = page.getByTestId("social-join-requests");
  await expect(section.getByTestId("join-request")).toContainText(
    "Sam Stranger asked to join Nebula.",
    { timeout: 20_000 },
  );
  await section.getByTestId("join-accept").click();
  await expect(section.getByTestId("join-added")).toContainText(
    "Sam Stranger is on the team.",
  );
  await expect.poll(() => teamTagsOf(relay).length).toBe(2);
  expect(teamTagsOf(relay)).toContainEqual(["team", STRANGER, "member"]);
});

test("the founder copies the link that invites people, and the team and the founder are not offered Ask to join", async ({
  page,
  context,
}) => {
  await context
    .grantPermissions(["clipboard-read", "clipboard-write"])
    .catch(() => {});
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  await expect(team.getByTestId("team-copy-link")).toHaveText(
    "Copy link to invite people",
    { timeout: 20_000 },
  );
  await team.getByTestId("team-copy-link").click();
  const origin = new URL(page.url()).origin;
  const copied = await page
    .evaluate(() => navigator.clipboard.readText())
    .catch(() => null);
  if (copied !== null) expect(copied).toBe(`${origin}${CARD}`);
  else
    await expect(team.getByTestId("team-copy-link-field")).toHaveValue(
      `${origin}${CARD}`,
    );
  // The founder is not offered to ask; neither is someone on the team, on either page.
  await expect(page.getByTestId("join-ask")).toHaveCount(0);
  await openAs(page, MATE_KEY, CARD);
  await expect(page.getByTestId("scorecard")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("join-ask")).toHaveCount(0);
  await expect(page.getByTestId("team-copy-link")).toHaveCount(0);
});

test("the server holds a stranger to asking: nothing else on the project, a person on the team need not, and a few asks only", () => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  const refusal = (e: ReturnType<typeof event>) =>
    projectRecordRefusal(e, relay.events);
  // A stranger may ask and may not post an update, a goal or a task.
  expect(refusal(askOf(STRANGER, "1"))).toBeNull();
  const as = (tags: string[][]) =>
    event(
      47003,
      STRANGER,
      { title: "x", body: "" },
      [["a", COORD], ...tags],
      now(),
    );
  expect(refusal(as([["update-part", "done", "Shipped"]]))).toContain(
    "only this project's team",
  );
  expect(refusal(as([["goal", "g1"]]))).toContain(
    "only this project's founder",
  );
  // An ask that is also anything else is refused.
  expect(
    refusal(
      as([
        ["l", "creaton-join"],
        ["join-ask", "abc"],
        ["update-part", "done", "x"],
      ]),
    ),
  ).toContain("cannot also be anything else");
  // The team and the founder are told they are on it already.
  expect(refusal(askOf(MATE, "m"))).toContain("already on this project's team");
  expect(refusal(askOf(FOUNDER, "f"))).toContain(
    "already on this project's team",
  );
  // Three asks to one project, then a plain refusal.
  for (const n of ["a", "b", "c"]) relay.seed(askOf(STRANGER, n));
  expect(refusal(askOf(STRANGER, "d"))).toContain(
    "already asked to join this project",
  );
});
