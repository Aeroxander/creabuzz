import { expect, test } from "@playwright/test";
import {
  ACCEPT_PATH_BUDGET,
  PLAN_V2_BUDGETS,
  PressCounter,
} from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  HOSTED_POLICY,
  install,
  now,
  openAs,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
} from "./helpers/world";

/**
 * Joining a project from its link in the new app (the milestone 0 flow): signed out on the hosted settings, Ask, the
 * name, the age and terms ticks and Create send the ask by themselves; the founder presses Accept once and the person
 * is on the team. Every press and field is counted against plan v2's Join budget (4 and 1).
 */

const FOUNDER_KEY = "c1".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const LINK = projectLink(FOUNDER, "nebula");

test("a new person joins in 4 presses and 1 field, and the founder accepts in 1 press", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "nebula",
      "Nebula",
      "Maps for night skies.",
      now() - 10 * DAY,
    ),
  );
  await install(page, relay, null, { keepSignUp: true, policy: HOSTED_POLICY });
  await page.goto(LINK);
  await expect(page.getByTestId("join-ask")).toBeVisible({ timeout: 20_000 });

  const path = new PressCounter();
  await path.press(page.getByTestId("join-ask"), "Ask to join (signed out)");
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 47003)).toHaveLength(0);
  await path.type(page.getByTestId("onboarding-name"), "Nia Newcomer", "Name");
  await path.tick(page.getByTestId("onboarding-policy-age"), "age");
  await path.tick(page.getByTestId("onboarding-policy-agree"), "terms");
  await path.press(page.getByTestId("onboarding-create"), "Create");

  // Back on the project, the ask goes by itself: no second press of Ask to join.
  await expect(page.getByTestId("join-asked")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(LINK);
  expect(path.presses).toBe(PLAN_V2_BUDGETS.join.presses);
  expect(path.fields).toBe(PLAN_V2_BUDGETS.join.fields);
  const asks = relay.events.filter(
    (e) => e.kind === 47003 && e.tags.some((t) => t[0] === "join-ask"),
  );
  expect(asks).toHaveLength(1);
  expect(asks[0].tags).toContainEqual(["p", FOUNDER]);
  expect(asks[0].tags).toContainEqual(["a", coordOf(FOUNDER, "nebula")]);
  const nia = asks[0].pubkey;
  // The name was saved with the account.
  const name = relay.events.find((e) => e.kind === 0 && e.pubkey === nia);
  expect(JSON.parse(name?.content ?? "{}").name).toBe("Nia Newcomer");
  // A reload sends no second ask.
  await page.reload();
  await expect(page.getByTestId("join-asked")).toBeVisible({ timeout: 20_000 });
  expect(
    relay.events.filter((e) => e.kind === 47003 && e.pubkey === nia),
  ).toHaveLength(1);

  // The founder sees the ask on People and accepts it with one press.
  await openAs(page, FOUNDER_KEY, LINK);
  await expect(page.getByTestId("project-name")).toHaveText("Nebula", {
    timeout: 20_000,
  });
  await page.getByTestId("tab-people").click();
  const accept = new PressCounter();
  await expect(page.getByTestId("join-accept")).toBeVisible({
    timeout: 20_000,
  });
  await accept.press(page.getByTestId("join-accept"), "Accept");
  await expect(page.getByTestId("join-asks")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(accept.presses).toBe(ACCEPT_PATH_BUDGET.presses);
  const records = relay.events
    .filter((e) => e.kind === 37001 && e.pubkey === FOUNDER)
    .sort((a, b) => b.created_at - a.created_at);
  expect(records[0].tags).toContainEqual(["team", nia, "member"]);
  await expect(page.getByTestId("project-people")).toContainText(
    "Nia Newcomer",
  );
  await expect(
    page.getByTestId("stage-line").locator('[aria-current="step"]'),
  ).toContainText("Team");
});
