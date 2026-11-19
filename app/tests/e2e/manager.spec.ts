import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  openAs,
  profile,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/world";
import { createMockRelay } from "./mock-relay";

/**
 * The manager's draft on the weekly update (plan v2, milestone 8), at 390x844. The weekly update keeps its 2 presses
 * and 1 box without the draft; with it the founder reads what the manager read, what it left out and that it can be
 * wrong, and copies only "What happened" into the box. "What's next" is never drafted, so no promise is made. The
 * server's answer is a stand-in; the real route is held by the server's own tests and the real-server loop.
 */

const FOUNDER_KEY = "b1".repeat(32);
const STRANGER_KEY = "b2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const STRANGER = pubkeyOf(STRANGER_KEY);
const COORD = coordOf(FOUNDER, "lantern");

const DRAFT = {
  schema: "creaton.manager.v1",
  loop_version: "manager-loop 2",
  read: "I read 1 record and 1 answer. I can be wrong.",
  this_week: [
    { text: "Light the next ten stalls.", from: ["r1"], records: [] },
  ],
  not_doing: [{ text: "A second market for now.", from: ["a1"], records: [] }],
  what_happened: [
    { text: "Lit ten stalls.", from: ["r1"], records: [] },
    { text: "Fixed the charger.", from: ["r1"], records: [] },
  ],
  needs_a_person: [
    { topic: "tax", ask: "Ask a tax adviser about this.", from: ["a1"] },
  ],
  dropped: 2,
  blocked: 1,
  set_aside: [],
  can_be_wrong: "This is a draft by an AI. It can be wrong.",
  notice: "AI service: a draft, not advice.",
};

function seed(relay: Relay) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
    ),
  );
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Week 3" },
      [
        ["a", COORD],
        ["update-part", "done", "Lit the first four stalls."],
      ],
      now() - 8 * DAY,
    ),
  );
}

/** The founder's own page on /week, with the server's manager answering `status` and `body`. */
async function openWeek(
  page: Page,
  relay: Relay,
  key: string,
  answer: { status: number; body: unknown } | null,
) {
  const asked: { auth: string; body: string }[] = [];
  await install(page, relay, key);
  await page.route("**/llm/manager/draft", async (route) => {
    const request = route.request();
    asked.push({
      auth: request.headers().authorization ?? "",
      body: request.postData() ?? "",
    });
    await route.fulfill({
      status: answer?.status ?? 404,
      contentType: "application/json",
      body: JSON.stringify(answer?.body ?? {}),
    });
  });
  await page.goto("/week");
  await expect(page.getByTestId("week-project")).toBeVisible({
    timeout: 20_000,
  });
  return asked;
}

const updates = (relay: Relay) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === FOUNDER &&
      e.tags.some((t) => t[0] === "update-part"),
  );

test(`The weekly update still takes ${PLAN_V2_BUDGETS.weeklyUpdate.presses} presses and ${PLAN_V2_BUDGETS.weeklyUpdate.fields} box with the manager there`, async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  const asked = await openWeek(page, relay, FOUNDER_KEY, null);
  const path = new PressCounter();
  await path.press(page.getByTestId("week-open"), "Post this week's update");
  await expect(page.getByTestId("manager-open")).toBeVisible();
  await path.type(
    page.getByTestId("weekly-text"),
    "Lit ten stalls.",
    "What did you do this week?",
  );
  await path.press(page.getByTestId("weekly-post"), "Post");
  await expect(page.getByTestId("toast")).toContainText("Posted", {
    timeout: 20_000,
  });
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.weeklyUpdate.presses,
  );
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.weeklyUpdate.fields);
  expect(asked).toEqual([]);
});

test("Draft with the manager: read what it read, copy only what happened, post it yourself", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  const asked = await openWeek(page, relay, FOUNDER_KEY, {
    status: 200,
    body: DRAFT,
  });
  await page.getByTestId("week-open").click();
  await page.getByTestId("manager-open").click();
  await page
    .getByTestId("manager-answer")
    .fill("We kept the second market for later.");
  await page.getByTestId("manager-ask").click();
  const draft = page.getByTestId("manager-draft");
  await expect(draft).toBeVisible({ timeout: 20_000 });

  // It says what it read, what it left out and that it can be wrong; a question for counsel goes to a person.
  await expect(page.getByTestId("manager-read")).toContainText(
    "I can be wrong",
  );
  await expect(page.getByTestId("manager-left-out")).toContainText(
    "2 lines were left out",
  );
  await expect(page.getByTestId("manager-person")).toContainText("tax adviser");
  await expect(page.getByTestId("manager-wrong")).toContainText(
    "It can be wrong. AI service",
  );
  // "What's next" is never drafted.
  await expect(draft).not.toContainText(/what's next/i);
  await expectAccessible(page, "The manager's draft");
  await expectNoSidewaysScroll(page, "The manager's draft");

  // The request was signed as the founder, named the project, and sent record ids, not text.
  expect(asked).toHaveLength(1);
  expect(asked[0].auth.startsWith("Nostr ")).toBe(true);
  const sent = JSON.parse(asked[0].body);
  expect(sent.project).toBe(COORD);
  expect(sent.items).toHaveLength(1);
  expect(sent.answers).toEqual(["We kept the second market for later."]);
  expect(sent.items[0]).toMatch(/^[0-9a-f]+$/);

  // Nothing is posted until the founder presses Post; "What happened" lands in the one box.
  expect(updates(relay)).toHaveLength(1);
  await page.getByTestId("manager-use").click();
  await expect(page.getByTestId("weekly-text")).toHaveValue(
    "Lit ten stalls.\nFixed the charger.",
  );
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("toast")).toContainText("Posted", {
    timeout: 20_000,
  });
  const posted = updates(relay).find((e) =>
    e.tags.some(
      (t) =>
        t[0] === "update-part" &&
        t[2] === "Lit ten stalls.\nFixed the charger.",
    ),
  );
  expect(posted).toBeTruthy();
  // No promise was made: the manager's lines cannot become one.
  expect(posted?.tags.some((t) => t[0] === "promise")).toBe(false);
  expect(
    posted?.tags.some((t) => t[0] === "update-part" && t[1] === "next"),
  ).toBe(false);
});

test("A refusal says what to do next and posts nothing", async ({ page }) => {
  const relay = createMockRelay();
  seed(relay);
  await openWeek(page, relay, FOUNDER_KEY, {
    status: 403,
    body: {
      error: "Post this week's update first, then ask again.",
      code: "ai_manager_post_weekly",
    },
  });
  await page.getByTestId("week-open").click();
  await page.getByTestId("manager-open").click();
  await page.getByTestId("manager-ask").click();
  await expect(page.getByTestId("manager-problem")).toHaveText(
    "Post this week's update first, then ask again.",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("manager-use")).toHaveCount(0);
  await expectAccessible(page, "The manager's refusal");
  expect(updates(relay)).toHaveLength(1);
});

test("Someone who did not start the project is never offered the manager", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  relay.seed(profile(STRANGER, "Sam Stranger"));
  await install(page, relay, STRANGER_KEY);
  await page.goto("/week");
  await openAs(page, STRANGER_KEY, "/week");
  await expect(page.getByTestId("week-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("manager-open")).toHaveCount(0);
  await expect(page.getByTestId("week-open")).toHaveCount(0);
});
