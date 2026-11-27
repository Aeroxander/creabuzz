import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
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
 * Phone screenshots of the new app at 390x844 (twice the pixels), for review: `pnpm screens`. They land in
 * test-results/screens/ (not committed). Each shot is checked to be a distinct screen before it is taken.
 */

const OUT = path.resolve(process.cwd(), "test-results/screens");
mkdirSync(OUT, { recursive: true });

const FAY_KEY = "e1".repeat(32);
const RAE_KEY = "e2".repeat(32);
const MAX_KEY = "e3".repeat(32);
const IDA_KEY = "e4".repeat(32);
const FAY = pubkeyOf(FAY_KEY);
const RAE = pubkeyOf(RAE_KEY);
const MAX = pubkeyOf(MAX_KEY);
const IDA = pubkeyOf(IDA_KEY);
const LANTERN = coordOf(FAY, "lantern");

function seed(relay: Relay) {
  relay.seed(
    profile(FAY, "Fay Okafor", "Solar lamps for night markets. Lagos."),
  );
  relay.seed(profile(RAE, "Rae Lindqvist", "Designer. Likes small tools."));
  relay.seed(profile(MAX, "Max Ito"));
  relay.seed(profile(IDA, "Ida Moreau"));
  relay.seed(
    projectRecord(
      FAY,
      "lantern",
      "Lantern",
      "Solar lamps that night-market stalls can repair themselves.",
      now() - 9 * DAY,
      [
        ["team", MAX, "member"],
        ["team-invite", MAX, "inv1"],
        ["p", MAX],
      ],
    ),
  );
  relay.seed(
    event(
      47003,
      MAX,
      { title: "Joined the team", body: "" },
      [
        ["a", LANTERN],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 8 * DAY,
    ),
  );
  relay.seed(
    event(
      47003,
      FAY,
      {
        title: "Goal set",
        body: "Ten stalls run a full night on one lamp.\nHow we'll know: ten stalls say so after a week.",
      },
      [
        ["a", LANTERN],
        ["goal", "g1"],
        ["goal-level", "primary"],
        ["goal-text", "Ten stalls run a full night on one lamp."],
        ["goal-how", "Ten stalls say so after a week."],
        ["goal-state", "open"],
      ],
      now() - 9 * DAY,
    ),
  );
  relay.seed(
    event(
      47003,
      FAY,
      {
        title: "Week 1",
        body: "Built the first lamp from parts sold at the market and gave it to Mama Bisi's stall. It ran until 2 a.m.",
      },
      [["a", LANTERN]],
      now() - 2 * DAY,
    ),
  );
  relay.seed(
    event(
      47003,
      MAX,
      {
        title: "Battery test",
        body: "Three cells, two brands. The cheaper one lost 30% after five nights.",
      },
      [["a", LANTERN]],
      now() - DAY,
    ),
  );
  relay.seed(
    projectRecord(
      RAE,
      "pocket-atlas",
      "Pocket Atlas",
      "Hand-drawn walking maps of small towns, printed on demand.",
      now() - 4 * DAY,
    ),
  );
  relay.seed(
    projectRecord(
      IDA,
      "seedbank",
      "Seedbank",
      "A seed library for a city block, with a shelf in the laundromat.",
      now() - 6 * DAY,
    ),
  );
  relay.seed(
    projectRecord(
      MAX,
      "quiet-hours",
      "Quiet Hours",
      "A tiny app that tells your neighbours when you need sleep.",
      now() - 12 * DAY,
    ),
  );
  const post = event(
    1,
    FAY,
    "First lamp is lit at Mama Bisi's stall. Ten stalls next — who knows a good supplier for 18650 cells?",
    [],
    now() - 5 * 3600,
  );
  relay.seed(post);
  const reply = event(
    1,
    RAE,
    "Lovely. Try the electronics row at Alaba, stall 14 — they test every cell.",
    [
      ["e", post.id, "", "root"],
      ["p", FAY],
    ],
    now() - 4 * 3600,
  );
  relay.seed(reply);
  relay.seed(
    event(
      1,
      MAX,
      "Seconding stall 14. Ask for the green-wrap ones.",
      [
        ["e", post.id, "", "root"],
        ["e", reply.id, "", "reply"],
        ["p", RAE],
        ["p", FAY],
      ],
      now() - 3 * 3600,
    ),
  );
  relay.seed(
    event(
      1,
      IDA,
      "Seedbank shelf is up. 41 packets on day one, 9 borrowed already.",
      [],
      now() - 9 * 3600,
    ),
  );
  relay.seed(
    event(
      7,
      RAE,
      "+",
      [
        ["e", post.id],
        ["p", FAY],
        ["k", "1"],
      ],
      now() - 4 * 3600,
    ),
  );
  relay.seed(
    event(
      7,
      IDA,
      "+",
      [
        ["e", post.id],
        ["p", FAY],
        ["k", "1"],
      ],
      now() - 2 * 3600,
    ),
  );
  relay.seed(event(3, RAE, "", [["p", FAY]], now() - 6 * 3600));
  return { post };
}

async function shoot(page: Page, name: string) {
  await waitForAnimations(page);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    caret: "hide",
    animations: "disabled",
  });
}

test.describe.configure({ mode: "serial" });

test("home", async ({ page }) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, RAE_KEY);
  await page.goto("/");
  await expect(page.getByTestId("project-card").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("project-card")).toHaveCount(4);
  await shoot(page, "01-home");
});

test("home, signed out", async ({ page }) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, null);
  await page.goto("/");
  await expect(page.getByTestId("home-welcome")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("project-card").first()).toBeVisible();
  await shoot(page, "02-home-signed-out");
});

test("project", async ({ page }) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, RAE_KEY);
  await page.goto(projectLink(FAY, "lantern"));
  await expect(page.getByTestId("project-update").first()).toBeVisible({
    timeout: 20_000,
  });
  await shoot(page, "03-project");
  await page.getByTestId("tab-people").click();
  await expect(page.getByTestId("person").nth(1)).toBeVisible();
  await page.getByTestId("tab-people").scrollIntoViewIfNeeded();
  await shoot(page, "04-project-people");
});

test("start", async ({ page }) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, RAE_KEY);
  await page.goto("/start");
  await page.getByTestId("start-name").fill("Night Sky Maps");
  await page
    .getByTestId("start-goal")
    .fill("A map of the night sky for one town that ten people use.");
  await page.getByTestId("start-how").fill("Ten people open it every week.");
  await expect(page.getByTestId("start-submit")).toBeEnabled();
  await shoot(page, "05-start");
});

test("you", async ({ page }) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay, FAY_KEY);
  await page.goto("/you");
  await expect(page.getByTestId("you-page")).toBeVisible({
    timeout: 20_000,
  });
  await shoot(page, "06-you");
});

test("sign-up", async ({ page }) => {
  const relay = createMockRelay();
  await install(page, relay, null, { policy: HOSTED_POLICY });
  await page.goto("/welcome");
  await expect(page.getByTestId("onboarding-policy")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("onboarding-name").fill("Nia Newcomer");
  await shoot(page, "07-sign-up");
});
