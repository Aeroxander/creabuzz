import { expect, test } from "@playwright/test";
import {
  ACCEPT_PATH_BUDGET,
  PLAN_V2_BUDGETS,
  PressCounter,
} from "../helpers/press-counter";
import { newPerson, phone, RUN, signUp } from "./people";

/**
 * Join against a real server with the hosted settings (`scripts/app-real-loop-e2e.sh`): a founder starts a project in
 * their own browser; a stranger opens its link signed out and asks to join (Ask, the name, the age tick, the terms tick,
 * Create: 4 presses and 1 field), and the ask is sent by itself once the account exists; the founder accepts in 1
 * press and the stranger is on the team.
 */

test("a stranger joins from the link in 4 presses and 1 field; the founder accepts in 1", async ({
  browser,
}) => {
  const founder = await phone(browser);
  await newPerson(founder, `Ida ${RUN}`);
  const name = `Lantern ${RUN}`;
  await founder.goto("/start");
  await founder.getByTestId("start-name").fill(name);
  await founder
    .getByTestId("start-goal")
    .fill("Solar lamps that ten night-market stalls use.");
  await founder.getByTestId("start-how").fill("Ten stalls light up with them.");
  await founder.getByTestId("start-submit").click();
  await expect(founder.getByTestId("project-name")).toHaveText(name);
  const link = new URL(founder.url()).pathname;

  const stranger = await phone(browser);
  await stranger.goto(link);
  await expect(stranger.getByTestId("join-ask")).toBeVisible();
  const path = new PressCounter();
  await path.press(
    stranger.getByTestId("join-ask"),
    "Ask to join (signed out)",
  );
  const joiner = `Nia ${RUN}`;
  await signUp(stranger, joiner, path);
  await expect(stranger.getByTestId("join-asked")).toBeVisible();
  expect(new URL(stranger.url()).pathname).toBe(link);
  console.log(path.summary("Join (real server, hosted settings)"));
  expect(path.presses).toBe(PLAN_V2_BUDGETS.join.presses);
  expect(path.fields).toBe(PLAN_V2_BUDGETS.join.fields);
  // A reload reads the ask back from the server and sends no second one.
  await stranger.reload();
  await expect(stranger.getByTestId("join-asked")).toBeVisible();

  await founder.reload();
  await founder.getByTestId("tab-people").click();
  const accept = new PressCounter();
  await accept.press(founder.getByTestId("join-accept"), "Accept");
  await expect(founder.getByTestId("join-asks")).toHaveCount(0);
  await expect(founder.getByTestId("project-people")).toContainText(joiner);
  expect(accept.presses).toBe(ACCEPT_PATH_BUDGET.presses);

  await stranger.reload();
  await expect(stranger.getByTestId("join-on-team")).toBeVisible();
  await expect(
    stranger.getByTestId("stage-line").locator('[aria-current="step"]'),
  ).toContainText("Team");
});
