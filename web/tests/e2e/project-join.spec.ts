import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import {
  ACCEPT_PATH_BUDGET,
  JOIN_PATH_BUDGET,
  JOIN_PATH_HOSTED_BUDGET,
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
    "Asked to join. It shows on the founder's Team card and in their Notifications.",
  );
  // Signed in, it is one press and nothing typed.
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

test("signed out on the hosted settings, one Ask, the age and terms ticks and Create send the ask by themselves once the account exists, and every press and field of the way is counted", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // The hosted server's sign-up: terms of use, a privacy note and the age box.
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({
      status: 200,
      json: {
        policy: {
          version: "v1",
          terms_markdown: "# Terms\n\nBe kind.",
          privacy_markdown: "# Privacy",
          age_attestation_required: true,
        },
      },
    }),
  );
  await install(page, relay, null, { keepSignUp: true });
  await page.goto(CARD);
  const card = page.getByTestId("scorecard");
  await expect(card).toBeVisible({ timeout: 20_000 });

  const path = new PressCounter();
  await path.press(card.getByTestId("join-ask"), "Ask to join (signed out)");
  const dialog = page.getByTestId("onboarding-dialog");
  await expect(dialog).toBeVisible();
  // Nothing is sent before the account exists.
  expect(
    relay.events.filter(
      (e) => e.kind === 47003 && e.tags.some((t) => t[0] === "join-ask"),
    ),
  ).toHaveLength(0);
  await path.type(page.getByTestId("onboarding-name"), "Nia Newcomer", "Name");
  await path.tick(page.getByTestId("onboarding-policy-age"), "age");
  await path.tick(page.getByTestId("onboarding-policy-agree"), "terms");
  await path.press(page.getByTestId("onboarding-create"), "Create");

  // The page reloads signed in on the same link and sends the ask: no second press of Ask to join.
  await expect(page.getByTestId("join-asked")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(CARD);
  expect(path.presses).toBe(JOIN_PATH_HOSTED_BUDGET.presses);
  expect(path.fields).toBe(JOIN_PATH_HOSTED_BUDGET.fields);
  // One ask was sent, once, by the account they just made, and a reload sends no second one.
  const asks = relay.events.filter(
    (e) => e.kind === 47003 && e.tags.some((t) => t[0] === "join-ask"),
  );
  expect(asks).toHaveLength(1);
  expect(asks[0].tags).toContainEqual(["p", FOUNDER]);
  await page.reload();
  await expect(page.getByTestId("join-asked")).toBeVisible({ timeout: 20_000 });
  expect(
    relay.events.filter(
      (e) => e.kind === 47003 && e.tags.some((t) => t[0] === "join-ask"),
    ),
  ).toHaveLength(1);
});

test("an Ask pressed on one project sends nothing on another project, and nothing once it is old", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  relay.seed(projectRecord(FOUNDER, "other", "Other", now() - 30 * DAY));
  await install(page, relay, STRANGER_KEY);
  // An Ask for this project that has waited ten and a half minutes for an account: too old to send by itself.
  await page.addInitScript((coordinate) => {
    if (window.sessionStorage.getItem("seeded")) return;
    window.sessionStorage.setItem("seeded", "1");
    window.sessionStorage.setItem(
      "creaton.join.after-sign-up",
      `${Date.now() - 10.5 * 60_000}|${coordinate}`,
    );
  }, COORD);
  await page.goto(CARD);
  // The button is enabled once the person's own asks are read: that is when a waiting press would be sent.
  await expect(page.getByTestId("join-ask")).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  expect(
    relay.events.filter(
      (e) => e.kind === 47003 && e.tags.some((t) => t[0] === "join-ask"),
    ),
  ).toHaveLength(0);
  // A press waiting for another project does not send either.
  await page.evaluate((other) => {
    window.sessionStorage.setItem(
      "creaton.join.after-sign-up",
      `${Date.now()}|${other}`,
    );
  }, `37001:${FOUNDER}:other`);
  await page.reload();
  // The button is enabled once the person's own asks are read: that is when a waiting press would be sent.
  await expect(page.getByTestId("join-ask")).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  expect(
    relay.events.filter(
      (e) => e.kind === 47003 && e.tags.some((t) => t[0] === "join-ask"),
    ),
  ).toHaveLength(0);
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

test("the mock server holds an ask to a small size and to the project's founder, and the founder alone turns one away", () => {
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  const refusal = (e: ReturnType<typeof event>) =>
    projectRecordRefusal(e, relay.events);
  const tags = (extra: string[][] = []) => [
    ["a", COORD],
    ["l", "creaton-join"],
    ["join-ask", "abc123"],
    ["p", FOUNDER],
    ...extra,
  ];
  const ask = (content: unknown, extra: string[][] = []) =>
    event(47003, STRANGER, content, tags(extra), now());
  expect(refusal(ask({ title: "Asked to join", body: "" }))).toBeNull();
  expect(refusal(ask({ body: "x".repeat(250_000) }))).toContain(
    "bytes of content",
  );
  expect(refusal(ask("{}", [["note", "y".repeat(2000)]]))).toContain("tags");
  // It names the founder and nobody else.
  expect(
    refusal(
      event(
        47003,
        STRANGER,
        "{}",
        [
          ["a", COORD],
          ["l", "creaton-join"],
          ["join-ask", "abc123"],
          ["p", MATE],
        ],
        now(),
      ),
    ),
  ).toContain("founder");
  expect(refusal(ask("{}", [["p", FOUNDER]]))).toContain("founder");
  // Turning an ask away is the founder's.
  const decline = (who: string) =>
    event(
      47003,
      who,
      { title: "x", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-join"],
        ["join-decline", STRANGER],
      ],
      now(),
    );
  expect(refusal(decline(FOUNDER))).toBeNull();
  expect(refusal(decline(MATE))).toContain("only this project's founder");
  expect(refusal(decline(STRANGER))).toContain("only this project's founder");
});

/** Asks signed by `count` strangers, one second apart from `from`, for the founder's flood tests. */
function seedAsks(relay: Relay, count: number, from: number, tag: string) {
  const strangers: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const who = pubkeyOf(
      (0x1000 + (tag === "j" ? i : 5000 + i)).toString(16).padStart(64, "0"),
    );
    strangers.push(who);
    relay.seed(
      event(
        47003,
        who,
        { title: "Asked to join", body: "" },
        [
          ["a", COORD],
          ["l", "creaton-join"],
          ["join-ask", `${tag}${i}`],
          ["l", "creaton-team"],
          ["team-answer", "yes"],
          ["team-invite", `${tag}${i}`],
          ["p", FOUNDER],
        ],
        from + i,
      ),
    );
  }
  return strangers;
}

test("the founder turns an ask away with Decline: nobody joins, and the ask is gone from the Team card and Notifications", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  await install(page, relay, STRANGER_KEY);
  await page.goto(CARD);
  await page.getByTestId("join-ask").click();
  await expect(page.getByTestId("join-asked")).toBeVisible();

  await openAs(page, FOUNDER_KEY, PROJECT);
  const team = page.getByTestId("project-team");
  await expect(team.getByTestId("join-request")).toContainText(
    "Sam Stranger asked to join",
    { timeout: 20_000 },
  );
  await expect(team.getByTestId("join-decline")).toHaveText("Decline");
  await team.getByTestId("join-decline").click();
  await expect(team.getByTestId("join-request")).toHaveCount(0);
  // One record signed by the founder, naming the person; the team is as it was.
  const declines = relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === FOUNDER &&
      e.tags.some((t) => t[0] === "join-decline"),
  );
  expect(declines).toHaveLength(1);
  expect(declines[0].tags).toEqual(
    expect.arrayContaining([
      ["a", COORD],
      ["l", "creaton-join"],
      ["join-decline", STRANGER],
    ]),
  );
  expect(teamTagsOf(relay)).toHaveLength(1);
  // It stays gone after a reload, and Notifications does not list it either.
  await page.reload();
  await expect(page.getByTestId("project-team")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("join-request")).toHaveCount(0);
  await openAs(page, FOUNDER_KEY, "/social/notifications");
  await expect(page.getByTestId("social-join-requests")).toHaveCount(0);
  // It is not shown as news on the project either.
  await openAs(page, FOUNDER_KEY, PROJECT);
  await expect(page.getByText("Turned an ask away")).toHaveCount(0);
});

test("a flood of asks from strangers cannot hide the real one: it is found past the newest page, and more waiting than shown is said", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // The real ask first; then 250 newer ones from fresh keys (more than the 200 one page reads).
  relay.seed(
    event(
      47003,
      STRANGER,
      { title: "Asked to join", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-join"],
        ["join-ask", "real1"],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "real1"],
        ["p", FOUNDER],
      ],
      now() - 5 * DAY,
    ),
  );
  seedAsks(relay, 250, now() - 4 * DAY, "j");
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  // The oldest is shown first, so the real one is at the top, found on the second page of the read.
  await expect(team.getByTestId("join-request").first()).toContainText(
    "Sam Stranger asked to join",
    { timeout: 20_000 },
  );
  // 251 are waiting and 50 are shown: the rest is said, and the read was not cut (it reached the end).
  await expect(team.getByTestId("join-request")).toHaveCount(50);
  await expect(team.getByTestId("join-hidden")).toContainText(
    "201 more asks are waiting.",
  );
  await expect(team.getByTestId("join-cut")).toHaveCount(0);
  // Notifications finds it too.
  await openAs(page, FOUNDER_KEY, "/social/notifications");
  const section = page.getByTestId("social-join-requests");
  await expect(section.getByTestId("join-request").first()).toContainText(
    "Sam Stranger asked to join Nebula.",
    { timeout: 20_000 },
  );
  await expect(section.getByTestId("social-join-hidden")).toContainText(
    "201 more asks are waiting.",
  );
});

test("older junk that fills the list in front of a real ask can be cleared one Decline at a time, and the real one then shows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay({ applyDeletions: true });
  seedWorld(relay);
  // 52 junk asks, then the real one: the list shows 50, oldest first, so the real one is the 53rd and hidden.
  seedAsks(relay, 52, now() - 5 * DAY, "j");
  relay.seed(
    event(
      47003,
      STRANGER,
      { title: "Asked to join", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-join"],
        ["join-ask", "real1"],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "real1"],
        ["p", FOUNDER],
      ],
      now() - DAY,
    ),
  );
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const team = page.getByTestId("project-team");
  await expect(team.getByTestId("join-hidden")).toContainText(
    "3 more asks are waiting.",
    { timeout: 20_000 },
  );
  await expect(team.getByText("Sam Stranger asked to join")).toHaveCount(0);
  for (let n = 0; n < 3; n += 1) {
    await team.getByTestId("join-decline").first().click();
    // Still a full list of 50: a hidden ask moves up into the place the declined one left.
    await expect(team.getByTestId("join-request")).toHaveCount(50, {
      timeout: 20_000,
    });
  }
  await expect(team.getByTestId("join-hidden")).toHaveCount(0);
  await expect(team.getByTestId("join-request").last()).toContainText(
    "Sam Stranger asked to join",
  );
});
