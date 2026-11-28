import { expect, type Page, test } from "@playwright/test";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { waitForAnimations } from "../helpers/animations";
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
 * The money screens at phone width (390, and 360 with larger text) and at desktop width, in a real browser against a real
 * chain: nothing scrolls sideways, every press is at least 44 px square (a touch target), and the sheets fit the screen
 * with their press reachable. The pages' own chrome (the project page's Back, Follow and tab strip, You's Edit, Link this wallet and tab strip: all 40 px) is not part of this check. Screenshots go to test-results/pot-screens for a person to look at.
 */

const world = liveWorld();
const SIZES = [
  { name: "phone-390", width: 390, height: 844, text: 1 },
  { name: "phone-360-large-text", width: 360, height: 740, text: 1.25 },
  { name: "desktop-1280", width: 1280, height: 800, text: 1 },
] as const;

/** Visible presses (buttons, radios, links, fields) smaller than 44 px in a direction, by what they say. */
async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((root) => {
    const area = document.querySelector(root) ?? document.body;
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 1 &&
        r.height > 1 &&
        getComputedStyle(el).visibility !== "hidden"
      );
    };
    const out: string[] = [];
    for (const el of area.querySelectorAll(
      "button, a[href], input, select, summary, [role=tab]",
    )) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      // A radio or checkbox is judged by its label (the thing a thumb presses).
      const target =
        el instanceof HTMLInputElement &&
        (el.type === "radio" || el.type === "checkbox")
          ? (el.closest("label") ?? el)
          : el;
      const t = target.getBoundingClientRect();
      if (
        Math.min(t.width, t.height) < 43.5 &&
        Math.min(r.width, r.height) < 43.5
      )
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40)}" ${Math.round(t.width)}x${Math.round(t.height)}`,
        );
    }
    return out;
  }, scope);
}

/** The sheet's press is on the screen (inside it) after scrolling to it. */
async function pressReachable(page: Page) {
  const press = page.getByTestId("sheet-confirm");
  await press.scrollIntoViewIfNeeded();
  const box = await press.boundingBox();
  const view = page.viewportSize();
  expect(box, "the press has a box").not.toBeNull();
  if (!box || !view) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
}

for (const size of SIZES)
  test(`the money screens fit at ${size.name}`, async ({ browser }) => {
    const w = world.get();
    const project = await launchProject(
      w,
      `layout${size.width}`,
      FOUNDER_NOSTR,
    );
    await backFor(w, project, w.who.backer, 100n);
    await backFor(w, project, w.who.second, 60n);
    await passTime(1000);
    await checkIn(w, project);
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 2,
      isMobile: size.width < 600,
      hasTouch: size.width < 600,
    });
    const shot = (page: Page, name: string) =>
      page.screenshot({
        path: `test-results/pot-screens/${name}-${size.name}.png`,
        fullPage: false,
      });
    try {
      // The holder: Money tab, Back sheet, Take out sheet, faucet.
      const page = await context.newPage();
      await openMoney(page, w, project, { account: w.who.backer });
      if (size.text !== 1)
        await page.addStyleTag({
          content: `html { font-size: ${size.text * 100}% !important; }`,
        });
      await expect(page.getByTestId("holding-shares")).toBeVisible();
      await waitForAnimations(page);
      await expectNoSidewaysScroll(page, `Money tab at ${size.name}`);
      expect(
        await smallTargets(page, '[data-testid="project-money"]'),
        `Money tab at ${size.name}: presses under 44 px`,
      ).toEqual([]);
      await page.screenshot({
        path: `test-results/pot-screens/money-tab-${size.name}.png`,
        fullPage: true,
      });

      await page.getByTestId("backing-amount").fill("25");
      await page.getByTestId("backing-review").click();
      await expect(page.getByTestId("back-shares")).toBeVisible();
      await waitForAnimations(page);
      await expectNoSidewaysScroll(page, `Back sheet at ${size.name}`);
      expect(
        await smallTargets(page, '[data-testid="back-sheet"]'),
        `Back sheet at ${size.name}: presses under 44 px`,
      ).toEqual([]);
      await pressReachable(page);
      await shot(page, "back-sheet");
      await page.keyboard.press("Escape");

      await page.getByTestId("holding-take-out").click();
      await expect(page.getByTestId("takeout-cash")).toBeVisible();
      await waitForAnimations(page);
      await expectNoSidewaysScroll(page, `Take out sheet at ${size.name}`);
      expect(
        await smallTargets(page, '[data-testid="takeout-sheet"]'),
        `Take out sheet at ${size.name}: presses under 44 px`,
      ).toEqual([]);
      await pressReachable(page);
      await shot(page, "takeout-sheet");
      await page.keyboard.press("Escape");

      // The runner: allowance and its sheets.
      const runner = await context.newPage();
      await openMoney(runner, w, project, { account: w.who.founder });
      if (size.text !== 1)
        await runner.addStyleTag({
          content: `html { font-size: ${size.text * 100}% !important; }`,
        });
      await expect(runner.getByTestId("allowance-section")).toBeVisible();
      await waitForAnimations(runner);
      await expectNoSidewaysScroll(
        runner,
        `Money tab for the runner at ${size.name}`,
      );
      expect(
        await smallTargets(runner, '[data-testid="project-money"]'),
        `runner's Money tab at ${size.name}: presses under 44 px`,
      ).toEqual([]);
      await runner.screenshot({
        path: `test-results/pot-screens/runner-${size.name}.png`,
        fullPage: true,
      });
      for (const [opener, sheet] of [
        ["allowance-draw", "draw-sheet"],
        ["allowance-rate-open", "rate-sheet"],
      ]) {
        await runner.getByTestId(opener).click();
        await expect(runner.getByTestId(sheet)).toBeVisible();
        await waitForAnimations(runner);
        await expectNoSidewaysScroll(runner, `${sheet} at ${size.name}`);
        expect(
          await smallTargets(runner, `[data-testid="${sheet}"]`),
          `${sheet} at ${size.name}: presses under 44 px`,
        ).toEqual([]);
        await pressReachable(runner);
        await runner.keyboard.press("Escape");
      }

      // You, with the person's Shares across projects.
      await page.goto("/you");
      await expect(page.getByTestId("your-shares-list")).toBeVisible({
        timeout: 20_000,
      });
      await waitForAnimations(page);
      await expectNoSidewaysScroll(page, `You at ${size.name}`);
      expect(
        await smallTargets(page, '[data-testid="your-shares-list"]'),
        `You at ${size.name}: presses under 44 px`,
      ).toEqual([]);
      await page.screenshot({
        path: `test-results/pot-screens/you-${size.name}.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
