import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import {
  backFor,
  checkIn,
  launchProject,
  NO_CHAIN_WHY,
  passTime,
} from "./helpers/live-chain";
import { FOUNDER_NOSTR, liveWorld, openMoney } from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The money screens in a real browser with axe, colour contrast and all (the jsdom run of the same screens cannot judge
 * colour or layout): the Money tab, the Back sheet, the Take out sheet and the runner's sheets. Then the keyboard:
 * Tab stays inside an open sheet, Escape closes it, and focus goes back to the button that opened it.
 */

const world = liveWorld();

/** Whether the element with focus is inside `selector`'s element. */
const focusInside = (page: Page, testId: string) =>
  page.evaluate(
    (id) =>
      Boolean(
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.contains(document.activeElement),
      ),
    testId,
  );

test("the Money tab, the Back sheet and the Take out sheet have no serious accessibility violation", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "a11yone", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await backFor(w, project, w.who.second, 60n);
  await checkIn(w, project);
  await openMoney(page, w, project, { account: w.who.backer });
  await expect(page.getByTestId("holding-shares")).toBeVisible();
  await expectAccessible(page, "Money tab");

  await page.getByTestId("backing-amount").fill("25");
  await page.getByTestId("backing-review").click();
  await expect(page.getByTestId("back-shares")).toBeVisible();
  await expectAccessible(page, "Back sheet");
  await page.getByTestId("back-sheet").getByText("Details").click();
  await expectAccessible(page, "Back sheet, details open");
  await page.keyboard.press("Escape");

  await page.getByTestId("holding-take-out").click();
  await expect(page.getByTestId("takeout-cash")).toBeVisible();
  await expectAccessible(page, "Take out sheet");
  await page.keyboard.press("Escape");
});

test("the runner's money screens and the quiet-project and old-record states have no serious violation", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "a11ytwo", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 60n);
  await passTime(1000);
  await checkIn(w, project);
  await openMoney(page, w, project, { account: w.who.founder });
  await expect(page.getByTestId("allowance-section")).toBeVisible();
  await expectAccessible(page, "Money tab for the runner");
  for (const [opener, sheet] of [
    ["allowance-draw", "draw-sheet"],
    ["allowance-rate-open", "rate-sheet"],
    ["allowance-door", "door-sheet"],
  ]) {
    await page.getByTestId(opener).click();
    await expect(page.getByTestId(sheet)).toBeVisible();
    await expectAccessible(page, sheet);
    await page.keyboard.press("Escape");
  }
  // A project that went quiet, and an old record.
  await passTime(3 * 1680);
  const quiet = await page.context().newPage();
  await openMoney(quiet, w, project, {
    account: w.who.second,
    patch: (c) => {
      c.builtAt = (c.builtAt as number) - 2 * 86_400;
    },
  });
  await expect(quiet.getByTestId("money-stale")).toBeVisible();
  await expectAccessible(quiet, "Money tab, old record, project gone quiet");
});

test("Tab stays inside a sheet, Escape closes it, and focus returns to the button that opened it", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "keyboard", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await checkIn(w, project);
  await openMoney(page, w, project, { account: w.who.backer });
  await expect(page.getByTestId("holding-take-out")).toBeVisible();

  // The Take out sheet, opened and closed by keyboard.
  const opener = page.getByTestId("holding-take-out");
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("takeout-sheet")).toBeVisible();
  await expect(page.getByTestId("takeout-cash")).toBeVisible();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await focusInside(page, "takeout-sheet"),
      `Tab ${i + 1} stays in the sheet`,
    ).toBe(true);
  }
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await focusInside(page, "takeout-sheet"),
      `Shift+Tab ${i + 1} stays in the sheet`,
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("takeout-sheet")).toBeHidden();
  await expect(opener).toBeFocused();

  // The Back sheet: typed with the keyboard, opened with Enter on the Back button, closed with Escape; focus returns to that button.
  await page.getByTestId("backing-amount").focus();
  await page.keyboard.type("10");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("backing-review")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("back-sheet")).toBeVisible();
  await expect(page.getByTestId("back-shares")).toBeVisible();
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await focusInside(page, "back-sheet"),
      `Tab ${i + 1} stays in the Back sheet`,
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("back-sheet")).toBeHidden();
  await expect(page.getByTestId("backing-review")).toBeFocused();
});
