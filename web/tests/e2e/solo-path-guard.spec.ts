import { expect, test, type Page } from "@playwright/test";

import { PressCounter, SOLO_PATH_BUDGET } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";

/**
 * The guard on the solo path: a person alone, with no account and nobody else, goes from Home to "First piece of work
 * done" in at most 8 presses and 4 typed fields (the build plan, section 2). It walks the real screens through the
 * counter in `helpers/press-counter.ts`, so a new button, a new box or a new tick that the path has to go through
 * fails here. The sequence is the plan's: the goal on Home, the project name and one example on Start, the sign-up
 * dialog with its two boxes, then "Add what you did" and one line.
 *
 * The same path is run against a real server in `e2e-real/solo-path.spec.ts`.
 */

const GOAL = "A first page that three people read";
const NAME = "Lantern";
const WHO = "Sol Okafor";
const WORK = "Wrote the first page";

/** The pilot's sign-up: terms, a privacy note and an age box, so both boxes have to be ticked. */
async function pilotTerms(page: Page) {
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
}

async function quietChain(page: Page) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
}

const SIZES = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "390x844", width: 390, height: 844 },
];

for (const size of SIZES) {
  test(`at ${size.name}: Home to first piece of work done is at most ${SOLO_PATH_BUDGET.presses} presses and ${SOLO_PATH_BUDGET.fields} typed fields`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const relay = createMockRelay({ applyDeletions: true });
    await quietChain(page);
    await pilotTerms(page);
    await relay.install(page);
    await page.goto("/");

    const path = new PressCounter();

    // Home: the goal is the one box, "Start a project" the one button.
    const hero = page.getByTestId("home-welcome");
    await expect(hero).toBeVisible();
    await path.read(page, "Home", hero);
    await path.type(
      hero.getByLabel("What are you making?"),
      GOAL,
      "What are you making?",
    );
    await path.press(hero.getByTestId("home-welcome-start"), "Start a project");

    // Start: the goal arrived, the cursor is in Project name, one example fills how it will be known.
    const form = page.getByTestId("quick-start");
    await expect(form.getByLabel("What is the goal?")).toHaveValue(GOAL);
    await expect(form.getByLabel("Project name")).toBeFocused();
    await path.read(page, "Start", form);
    await path.type(form.getByLabel("Project name"), NAME, "Project name");
    await path.press(form.getByTestId("quick-how-number"), "an example");
    await expect(
      form.getByLabel("How will people know it worked?"),
    ).not.toHaveValue("");
    await path.press(form.getByTestId("quick-start-go"), "Start the project");

    // The account: a name, the age box, the terms box, and the one button the device supports.
    const dialog = page.getByTestId("onboarding-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("onboarding-policy-age")).toBeVisible();
    await path.read(page, "Create your account");
    // The legal text is as the pilot wrote it: the path is shorter, the words are not touched.
    const policy = page.getByTestId("onboarding-policy");
    await expect(policy).toContainText("I am 18 years of age or older.");
    await expect(policy).toContainText(
      "I agree to the Terms of use and have read the Privacy note. Posts and votes are public.",
    );
    await path.type(page.getByTestId("onboarding-name"), WHO, "Name");
    await path.tick(page.getByTestId("onboarding-policy-age"), "age");
    await path.tick(page.getByTestId("onboarding-policy-agree"), "terms");
    await path.press(
      page.getByTestId("onboarding-create"),
      "Create without a passkey",
    );

    // The project page opens on one first-week card; the project is made with no second press.
    await expect(page).toHaveURL(/\/launchpad\/lantern\?.*started=1/, {
      timeout: 30_000,
    });
    const card = page.getByTestId("first-week");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await path.read(page, "the project page", card);
    await path.press(page.getByTestId("first-week-add"), "Add what you did");

    // One box, one line, one button.
    const win = page.getByRole("dialog", { name: "What did you get done?" });
    await expect(win).toBeVisible();
    await path.read(page, "What did you get done?");
    await path.type(
      win.getByLabel("What did you finish?"),
      WORK,
      "What you did",
    );
    await path.press(win.getByRole("button", { name: "Done" }), "Done");
    await expect(page.getByTestId("first-week-work-done")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("first-week-work-done")).toContainText(
      "First piece of work done",
    );

    const counts = path.counts();
    console.log(path.summary(`solo path at ${size.name}`));
    for (const line of counts.log) console.log(`[path]   ${line}`);

    // What the server was given: one project, and the one piece of work made, handed in and checked by the founder.
    expect(relay.events.filter((e) => e.kind === 37001)).toHaveLength(1);
    const parts = relay.events
      .filter((e) => e.kind === 47003)
      .flatMap((e) =>
        e.tags.filter((t) => t[0] === "task-part").map((t) => t[1]),
      );
    expect(parts.filter((p) => p === "task")).toHaveLength(1);
    expect(parts.filter((p) => p === "evidence")).toHaveLength(1);
    expect(parts.filter((p) => p === "confirm")).toHaveLength(1);

    // The budget. A press or a field added anywhere on the path fails here, with the log above to say where.
    expect(counts.presses).toBeLessThanOrEqual(SOLO_PATH_BUDGET.presses);
    expect(counts.fields).toBeLessThanOrEqual(SOLO_PATH_BUDGET.fields);
  });
}

test("the counter counts what it is given: a press, a tick and a typed box each add one", async ({
  page,
}) => {
  await page.setContent(
    `<input id="a" /><input type="checkbox" id="b" /><button id="c">Go</button>`,
  );
  const path = new PressCounter();
  await path.type(page.locator("#a"), "one two three", "a");
  await path.tick(page.locator("#b"), "b");
  await path.press(page.locator("#c"), "c");
  expect(path.counts()).toMatchObject({
    presses: 2,
    fields: 1,
    typedWords: 3,
  });
});
