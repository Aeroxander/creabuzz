import { expect, type Page, test } from "@playwright/test";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  HOSTED_POLICY,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/world";

/**
 * The new app's smoke run at phone size (390x844, touch): the sign-up screen with the legal boxes, Home, a project,
 * You, and Start's press budget. One mock server, the same one web/'s specs use.
 */

const FOUNDER_KEY = "d1".repeat(32);
const READER_KEY = "d2".repeat(32);
const MATE_KEY = "d3".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const READER = pubkeyOf(READER_KEY);
const MATE = pubkeyOf(MATE_KEY);
const PROJECT = projectLink(FOUNDER, "lantern");

function seed(relay: Relay) {
  relay.seed(profile(FOUNDER, "Fay Founder", "Building lamps that last."));
  relay.seed(profile(READER, "Rae Reader"));
  relay.seed(profile(MATE, "Max Mate"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 3 * DAY,
      [
        ["team", MATE, "member"],
        ["team-invite", MATE, "inv1"],
        ["p", MATE],
      ],
    ),
  );
  // Max's own yes to the invitation: he is on the team.
  relay.seed(
    event(
      47003,
      MATE,
      { title: "Joined the team", body: "" },
      [
        ["a", coordOf(FOUNDER, "lantern")],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 2 * DAY,
    ),
  );
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Week 1", body: "Built the first lamp and gave it to a stall." },
      [["a", coordOf(FOUNDER, "lantern")]],
      now() - DAY,
    ),
  );
  relay.seed(
    projectRecord(
      MATE,
      "seedbank",
      "Seedbank",
      "A shared seed library.",
      now() - 6 * DAY,
    ),
  );
  const post = event(
    1,
    FOUNDER,
    "First lamp is lit. Ten stalls next.",
    [],
    now() - 5 * 3600,
  );
  relay.seed(post);
  relay.seed(
    event(
      1,
      READER,
      "Lovely. Which stall?",
      [
        ["e", post.id, "", "root"],
        ["p", FOUNDER],
      ],
      now() - 3600,
    ),
  );
  return { post };
}

/** At most one green button on screen (DIRECTION.md: one green button per screen). */
async function expectAtMostOneGreen(page: Page, surface: string) {
  const greens = await page.locator(".btn-primary:visible").count();
  expect(greens, `${surface}: green buttons on screen`).toBeLessThanOrEqual(1);
}

test("sign-up shows the legal boxes word for word and waits for them", async ({
  page,
}) => {
  const relay = createMockRelay();
  await install(page, relay, null, { policy: HOSTED_POLICY });
  await page.goto("/welcome");
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-policy-age")).toBeVisible();
  const policy = page.getByTestId("onboarding-policy");
  await expect(policy).toContainText("I am 18 years of age or older.");
  await expect(policy).toContainText(
    "I agree to the Terms of use and have read the Privacy note. Posts and votes are public.",
  );
  await page.getByTestId("onboarding-name").fill("Nia Newcomer");
  await expect(page.getByTestId("onboarding-create")).toBeDisabled();
  await expect(page.getByTestId("onboarding-tick-hint")).toHaveText(
    "Tick both boxes to continue.",
  );
  await page.getByTestId("onboarding-policy-age").check();
  await page.getByTestId("onboarding-policy-agree").check();
  await expect(page.getByTestId("onboarding-create")).toBeEnabled();
  await expectAtMostOneGreen(page, "sign-up");
  await expectNoSidewaysScroll(page, "sign-up");
  await expect(page.getByTestId("tab-bar")).toHaveCount(0);
});

test("Home shows projects and posts, never sorted by money, at phone width", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  await expect(page.getByTestId("project-card").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("home-projects")).toContainText("Lantern");
  await expect(page.getByTestId("home-projects")).toContainText("Seedbank");
  await expect(page.getByTestId("post-card").first()).toContainText(
    "First lamp is lit",
  );
  // Investing is off unless the server says so: no rounds slot.
  await expect(page.getByTestId("home-rounds")).toHaveCount(0);
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page.getByTestId("tab-link-home")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectAtMostOneGreen(page, "Home");
  await expectNoSidewaysScroll(page, "Home");
  // The font is Geist, from this origin.
  const font = await page.evaluate(
    () => getComputedStyle(document.body).fontFamily,
  );
  expect(font).toContain("Geist");
});

test("the open rounds slot shows only where the server turns investing on", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, READER_KEY, { investing: true });
  await page.goto("/");
  await expect(page.getByTestId("rounds-placeholder")).toBeVisible({
    timeout: 20_000,
  });
});

test("a project shows its stage, its updates and its people; Tasks and Money are marked as coming", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, READER_KEY);
  await page.goto(PROJECT);
  await expect(page.getByTestId("project-name")).toHaveText("Lantern", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("stage-line")).toContainText("Team");
  await expect(page.locator('[aria-current="step"]')).toContainText("Team");
  await expect(page.getByTestId("project-update").first()).toContainText(
    "Built the first lamp",
  );
  await expect(page.getByTestId("join-ask")).toBeVisible();
  await expectAtMostOneGreen(page, "Project");
  await page.getByTestId("tab-people").click();
  await expect(page.getByTestId("project-people")).toContainText("Fay Founder");
  await expect(page.getByTestId("project-people")).toContainText("Max Mate");
  await page.getByTestId("tab-tasks").click();
  await expect(page.getByTestId("tasks-placeholder")).toBeVisible();
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("money-off")).toBeVisible();
  await expect(page.getByTestId("tab-link-home")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectNoSidewaysScroll(page, "Project");
});

test("a post opens with its comments", async ({ page }) => {
  const relay = createMockRelay();
  const { post } = seed(relay);
  await install(page, relay, READER_KEY);
  await page.goto(`/post/${post.id}`);
  await expect(page.getByTestId("post-focus")).toContainText(
    "First lamp is lit",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("comment")).toContainText("Which stall?");
  await expectAtMostOneGreen(page, "Post");
});

test("You shows notifications, projects and the account, signed in", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto("/you");
  await expect(page.getByTestId("profile-head")).toContainText("Fay Founder", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("notification").first()).toContainText(
    "replied to you",
  );
  await page.getByTestId("tab-account").click();
  await expect(page.getByTestId("sign-out")).toBeVisible();
  await expectNoSidewaysScroll(page, "You");
});

test("You asks a signed-out person to make an account", async ({ page }) => {
  const relay = createMockRelay();
  await install(page, relay, null);
  await page.goto("/you");
  await expect(page.getByTestId("you-signed-out")).toBeVisible();
  await expectAtMostOneGreen(page, "You, signed out");
});

test("Start: three answers and the presses the plan allows, then the project's page", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  await expect(page.getByTestId("project-card").first()).toBeVisible({
    timeout: 20_000,
  });
  const path = new PressCounter();
  await path.press(page.getByTestId("tab-link-start"), "Start tab");
  await path.type(page.getByTestId("start-name"), "Night Sky Maps", "Name");
  await path.type(
    page.getByTestId("start-goal"),
    "A map of the night sky that ten people use.",
    "Goal",
  );
  await path.type(
    page.getByTestId("start-how"),
    "Ten people use it every week.",
    "How",
  );
  await expectAtMostOneGreen(page, "Start");
  await path.press(page.getByTestId("start-submit"), "Start");
  await expect(page.getByTestId("project-name")).toHaveText("Night Sky Maps", {
    timeout: 20_000,
  });
  expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.start.presses);
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.start.fields);
  const record = relay.events.find(
    (e) => e.kind === 37001 && e.pubkey === READER,
  );
  expect(record?.tags).toContainEqual(["d", "night-sky-maps"]);
  const goal = relay.events.find(
    (e) =>
      e.kind === 47003 &&
      e.pubkey === READER &&
      e.tags.some((t) => t[0] === "goal"),
  );
  expect(goal?.tags).toContainEqual(["a", coordOf(READER, "night-sky-maps")]);
});
