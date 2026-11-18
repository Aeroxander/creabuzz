import { expect, test, type Page } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import { install, now, projectRecord, pubkeyOf } from "./helpers/project-world";

/**
 * Home's goal box into Start, and Start's short form.
 *
 * Every signed-out visitor, on every server, sees one box on Home ("What are you making?") and one green button.
 * Typing a goal and pressing the button (or Enter) opens Start with the goal filled in and the cursor in "Project
 * name"; nothing is sent until Start's own button. Start itself is three short answers: few words, and its button
 * within reach at 1280x800 and within one scroll at 390x844.
 */

const SIZES = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
];

const GOAL = "A first page that three people read.";

async function visit(page: Page, path: string, listed: boolean) {
  const relay = createMockRelay({ applyDeletions: true });
  if (listed)
    relay.seed(
      projectRecord(
        pubkeyOf("f1".repeat(32)),
        "rhythm",
        "Rhythm",
        now() - 3600,
      ),
    );
  await install(page, relay, null);
  await page.goto(path);
  return relay;
}

/** The filled green buttons and links in an element: how the "one green button" rule is counted. */
const greens = (scope: ReturnType<Page["locator"]>) =>
  scope.locator("button.bg-primary, a.bg-primary");

for (const size of SIZES) {
  for (const listed of [false, true]) {
    test(`at ${size.name}, ${listed ? "on a server that lists projects" : "on an empty server"}, the goal typed on Home lands in Start, with the cursor in Project name`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const relay = await visit(page, "/", listed);

      const hero = page.getByTestId("home-welcome");
      await expect(hero).toBeVisible();
      // One page title, one filled green button in the box, and the goal's own label.
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(greens(hero)).toHaveCount(1);
      await expect(greens(hero)).toHaveText("Start a project");
      await expect(hero.getByLabel("What are you making?")).toHaveAttribute(
        "placeholder",
        "A first version that ten people use.",
      );
      await expect(hero.getByTestId("home-welcome-work")).toHaveText(
        "Find work",
      );
      // "Find work" is a quiet link, not a second button.
      await expect(hero.getByTestId("home-welcome-work")).not.toHaveClass(
        /bg-primary|border-input/,
      );

      await hero.getByLabel("What are you making?").fill(GOAL);
      await hero.getByTestId("home-welcome-start").click();

      await expect(page).toHaveURL(/\/start$/);
      const form = page.getByTestId("quick-start");
      await expect(form.getByLabel("What is the goal?")).toHaveValue(GOAL);
      await expect(form.getByLabel("Project name")).toBeFocused();
      // Nothing was sent: the project is made only by Start's own button.
      expect(
        relay.events.filter(
          (e) =>
            e.kind === 37001 &&
            e.tags.some((t) => t[0] === "d" && t[1] !== "rhythm"),
        ),
      ).toHaveLength(0);
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("creaton.start.quick"),
        ),
      ).toContain("A first page that three people read.");
    });
  }
}

test("Enter in the goal box does what the button does", async ({ page }) => {
  await visit(page, "/", false);
  const box = page
    .getByTestId("home-welcome")
    .getByLabel("What are you making?");
  await box.fill(GOAL);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByLabel("What is the goal?")).toHaveValue(GOAL);
  await expect(page.getByLabel("Project name")).toBeFocused();
});

test("an empty goal box still opens Start, empty, with nothing kept", async ({
  page,
}) => {
  await visit(page, "/", false);
  await page.getByTestId("home-welcome-start").click();
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByLabel("What is the goal?")).toHaveValue("");
  // No goal arrived, so the cursor is where the person puts it.
  await expect(page.getByLabel("Project name")).not.toBeFocused();
});

test("a goal already typed on Start is the Home box's first value, and Home asks nothing signed in", async ({
  page,
}) => {
  await visit(page, "/start", false);
  await page.getByLabel("What is the goal?").fill("Ten built telescopes");
  await page.getByRole("link", { name: "Home" }).first().click();
  await expect(page.getByTestId("home-welcome-goal")).toHaveValue(
    "Ten built telescopes",
  );
});

test("Start is three short answers: under 100 words on the screen, the button in reach", async ({
  page,
}) => {
  await visit(page, "/start", false);
  const wordCount = () =>
    page.evaluate(() => (document.body.innerText.match(/\S+/g) ?? []).length);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("quick-start")).toBeVisible();
  expect(await wordCount()).toBeLessThan(100);
  const go = page.getByTestId("quick-start-go");
  const wide = await go.boundingBox();
  expect(wide?.y).toBeGreaterThan(0);
  expect((wide?.y ?? 0) + (wide?.height ?? 0)).toBeLessThanOrEqual(800);

  // The words the form uses, and the ones it dropped.
  const form = page.getByTestId("quick-start");
  await expect(form.getByLabel("Project name")).toBeVisible();
  await expect(form.getByLabel("What is the goal?")).toBeVisible();
  await expect(
    form.getByLabel("How will people know it worked?"),
  ).toBeVisible();
  await expect(form.getByText("Tap one to start")).toBeVisible();
  await expect(form.getByText("What kind of project?")).toBeVisible();
  await expect(
    page.getByText("Three short answers make your project page."),
  ).toBeVisible();
  await expect(page.getByText("Free to start")).toHaveCount(0);
  await expect(page.getByText("No money, no Shares")).toHaveCount(0);
  await expect(form.getByTestId("quick-next")).toHaveText(
    "Next you make a name for yourself. What you typed stays here.",
  );
  await expect(go).toHaveText("Start the project");
  // One filled green button in the form.
  await expect(greens(form)).toHaveCount(1);

  // The one-liner is under a closed "More options", and still works.
  const more = form.getByTestId("quick-pitch-edit");
  await expect(more.locator("summary")).toHaveText("More options");
  await expect(form.getByTestId("quick-pitch")).toHaveCount(0);
  await more.locator("summary").click();
  await form.getByTestId("quick-pitch").fill("A page three people read.");
  await expect(form.getByTestId("quick-pitch")).toHaveValue(
    "A page three people read.",
  );

  // On a phone the button is within one scroll of the page's own scroll area.
  await page.setViewportSize({ width: 390, height: 844 });
  const reach = await go.evaluate((button) => {
    const main = document.getElementById("app-main");
    if (!main) return null;
    const below =
      button.getBoundingClientRect().bottom -
      main.getBoundingClientRect().top +
      main.scrollTop;
    return { below, screen: main.clientHeight };
  });
  expect(reach).not.toBeNull();
  expect(reach?.below ?? Infinity).toBeLessThanOrEqual(
    (reach?.screen ?? 0) * 2,
  );
});

test("at 390 every control on Home's goal box and on Start is 44 px tall", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, "/", false);
  const small = (scope: ReturnType<Page["locator"]>) =>
    scope.locator("button, input, textarea, summary, a").evaluateAll((els) =>
      els
        .map((el) => ({
          what: `${el.tagName.toLowerCase()} ${el.getAttribute("data-testid") ?? (el.textContent ?? "").trim().slice(0, 30)}`,
          box: el.getBoundingClientRect(),
        }))
        .filter(
          ({ box }) => box.width > 0 && box.height > 0 && box.height < 43.5,
        )
        .map(({ what, box }) => `${what} (${Math.round(box.height)} px)`),
    );
  await expect(page.getByTestId("home-welcome")).toBeVisible();
  expect(await small(page.getByTestId("home-welcome"))).toEqual([]);

  await page.getByTestId("home-welcome-start").click();
  await expect(page.getByTestId("quick-start")).toBeVisible();
  // The chips, the boxes, "More options" and the button. (The start steps under "More ways to start" are closed.)
  expect(await small(page.getByTestId("quick-start"))).toEqual([]);
});
