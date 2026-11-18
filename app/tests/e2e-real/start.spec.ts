import { expect, test } from "@playwright/test";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { newPerson, phone, RUN } from "./people";

/**
 * Start and This week against a real server (`scripts/app-real-loop-e2e.sh`): a person who just signed up starts a
 * project with three answers, lands on its page, and posts the week's update from This week. Each path is counted
 * against plan v2's budgets; the server's own checks decide what is stored.
 */

test("Start in 3 answers and the presses the plan allows, then the week's update in 2 presses and 1 field", async ({
  browser,
}) => {
  const page = await phone(browser);
  await newPerson(page, `Fay ${RUN}`);
  const name = `Night Sky ${RUN}`;

  const start = new PressCounter();
  await start.press(page.getByTestId("tab-link-start"), "Start tab");
  await start.type(page.getByTestId("start-name"), name, "Name");
  await start.type(
    page.getByTestId("start-goal"),
    "A map of the night sky that ten people use.",
    "Goal",
  );
  await start.type(
    page.getByTestId("start-how"),
    "Ten people use it every week.",
    "How",
  );
  await start.press(page.getByTestId("start-submit"), "Start");
  // The server took both records: the page is read back from it.
  await expect(page.getByTestId("project-name")).toHaveText(name);
  await page.reload();
  await expect(page.getByTestId("project-name")).toHaveText(name);
  console.log(start.summary("Start (real server)"));
  expect(start.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.start.presses);
  expect(start.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.start.fields);

  await page.getByTestId("tab-link-this-week").click();
  const card = page.getByTestId("week-project").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("week-last-update")).toHaveText(
    "No updates yet",
  );
  const week = new PressCounter();
  await week.press(card.getByTestId("week-open"), "Post this week's update");
  await week.type(
    page.getByTestId("weekly-text"),
    "Drew the first constellation and showed it to three people.",
    "What did you do this week?",
  );
  await week.press(page.getByTestId("weekly-post"), "Post");
  await expect(page.getByTestId("toast")).toHaveText("Posted");
  await expect(card.getByTestId("week-last-update")).toHaveText(
    "Updated today",
  );
  console.log(week.summary("Weekly update (real server, no launch)"));
  expect(week.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.weeklyUpdate.presses,
  );
  expect(week.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.weeklyUpdate.fields);

  // The update shows on the project's page, read back from the server.
  await card.getByRole("link", { name }).click();
  await expect(page.getByTestId("project-update").first()).toContainText(
    "Drew the first constellation",
  );
});
