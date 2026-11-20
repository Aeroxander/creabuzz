// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  backFor,
  chainNow,
  launchProject,
  NO_CHAIN_WHY,
} from "./helpers/live-chain";
import {
  coordinateOf,
  FOUNDER_NOSTR,
  liveWorld,
  openMoney,
} from "./helpers/live-browser";
import { RELAY } from "./helpers/money-world";
import { event } from "./helpers/world";
import {
  exampleRecord,
  shapeOnlyIndexContent,
} from "../helpers/numbers-v2-fixture";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The project page's top in a real browser against a real chain (plan section 7.1): at 360 by 640 the name, the project's
 * money with its line, what taking out now would give, the banner and Back are all in view without scrolling; the banner is
 * on the page once; Share gives the link and a picture; the "Established" chip appears only for a project that reached it
 * and opens a sheet of three plain lines; a record past a day shows none of the money. The record's step 3 keys are the
 * example's, moved to the chain's clock.
 */

const world = liveWorld();
const PHONE = { width: 360, height: 640 };
const BANNER =
  "You can take your money out any time. Nothing here promises a profit.";
const NOT_A_RETURN = "This can go up or down. It is not a return.";

/** Whether an element is wholly in view without scrolling: inside the window and not under the tab bar. */
async function inView(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="tab-bar"]');
    const floor = bar
      ? Math.min(window.innerHeight, bar.getBoundingClientRect().top)
      : window.innerHeight;
    return (
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= floor &&
      r.right <= window.innerWidth
    );
  }, testId);
}

test("at 360 by 640 the name, the money, what taking out gives, the banner and Back are in the first screen", async ({
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "firstscreen", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await openMoney(page, w, project, { account: w.who.backer, tab: null });
  await expect(page.getByTestId("backing-review")).toBeVisible({
    timeout: 20_000,
  });
  for (const id of [
    "project-name",
    "top-money-pot",
    "top-take-out-now",
    "top-banner",
    "backing-review",
  ])
    expect(await inView(page, id), `${id} is in the first screen`).toBe(true);
  await expect(page.getByTestId("top-money")).toContainText(NOT_A_RETURN);
  await expect(page.getByTestId("top-take-out-now")).toContainText(
    "Taking out now would give",
  );
  await expect(page.getByTestId("top-take-out-now")).toContainText(
    "for each Share.",
  );
  await expect(page.getByTestId("top-banner")).toHaveText(BANNER);
  await expect(page.getByTestId("top-play-money")).toContainText(
    "The dollars are play money",
  );
  await expectNoSidewaysScroll(page, "the project page at 360");
  await expectAccessible(page, "the project page's top at 360");
  // For a person to look at.
  await page.screenshot({ path: "test-results/pot-screens/page-top-360.png" });
  await context.close();
});

test("the banner is on the page once, the Back box once, and Home has the shell's banner", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "onebanner", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, { account: w.who.stranger, tab: null });
  await expect(page.getByTestId("backing-box")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("money-banner")).toHaveCount(1);
  await expect(page.getByTestId("shell-banner")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Back this project" }),
  ).toHaveCount(1);
  // With the Money tab open there is still only one Back box.
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("project-money")).toBeVisible();
  await expect(page.getByTestId("backing-box")).toHaveCount(1);
  await page.getByTestId("tab-link-home").click();
  await expect(page.getByTestId("shell-banner")).toHaveText(BANNER);
  await expect(page.getByTestId("money-banner")).toHaveCount(1);
});

test("Share gives the link that shows no amounts, a copy that says so, and a picture", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "sharing", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openMoney(page, w, project, { account: w.who.backer, tab: null });
  await page.getByTestId("share-open").click({ timeout: 20_000 });
  const sheet = page.getByTestId("share-sheet");
  await expect(sheet).toContainText(
    "Anyone with the link can read the project. The link shows no amounts.",
  );
  const link = await sheet.getByLabel("Link to this project").inputValue();
  expect(new URL(link).pathname).toBe(new URL(page.url()).pathname);
  await sheet.getByTestId("share-copy").click();
  await expect(sheet.getByTestId("share-said")).toHaveText("Link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  // The picture is made on this device, 1,200 by 630, and has words for a screen reader.
  const picture = sheet.getByTestId("share-picture");
  await expect(picture).toBeVisible({ timeout: 10_000 });
  await expect(picture).toHaveAttribute("alt", /Lantern/);
  const size = await picture.evaluate((img: HTMLImageElement) => ({
    w: img.naturalWidth,
    h: img.naturalHeight,
  }));
  expect(size).toEqual({ w: 1200, h: 630 });
  await expect(sheet).toContainText(BANNER);
  await expectAccessible(page, "Share sheet");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("share-sheet")).toHaveCount(0);
  // Focus is back on the button that opened it.
  await expect(page.getByTestId("share-open")).toBeFocused();
});

test("the Established chip appears only for a project that reached it, and its sheet says why in three plain lines", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "established", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, {
    account: w.who.backer,
    tab: null,
    patch: (content) => {
      // The verdict is the rule on its own inputs, taken from the record's own rule.
      const e = content.established as Record<string, any>;
      e.heldBps = e.rule.minHeldBps;
      e.accounts = e.rule.minAccounts;
      e.twoSigners = true;
      e.reached = true;
    },
  });
  const chip = page.getByTestId("established-chip");
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip).toHaveText("Established");
  // One stop: the chip is one button, and it opens by the keyboard.
  await chip.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("established-sheet");
  await expect(sheet).toContainText(
    "Established is a hint. It is not a promise, and it changes nothing about your money.",
  );
  await expect(
    sheet.getByTestId("established-rows").getByRole("listitem"),
  ).toHaveCount(3);
  await expectAccessible(page, "Established sheet");
  await page.keyboard.press("Escape");
  await expect(chip).toBeFocused();
});

test("a project that is not Established has no chip, and Details says what is missing without shaming it", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "notyet", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, { account: w.who.backer, tab: null });
  await expect(page.getByTestId("backing-review")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("established-chip")).toHaveCount(0);
  await page.getByTestId("project-details").getByText("Details").click();
  await page.getByTestId("established-open").click();
  await expect(page.getByTestId("established-sheet")).toContainText("Not yet:");
});

test("a record past a day shows none of the money, no chip, and Back waits while taking out does not", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "oldrecord", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, {
    account: w.who.backer,
    tab: null,
    patch: (content) => {
      content.builtAt = (content.builtAt as number) - 2 * 86_400;
    },
  });
  await expect(page.getByTestId("top-money-stale")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("top-money-pot")).toHaveCount(0);
  await expect(page.getByTestId("established-chip")).toHaveCount(0);
  await expect(page.getByTestId("back-paused")).toBeVisible();
  await expect(page.getByTestId("top-banner")).toHaveText(BANNER);
});

test("Home ranks by money that stayed from the server's index: one link per row, the line under the heading, and it is accessible", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "ranked", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const { relay } = await openMoney(page, w, project, {
    account: w.who.backer,
    tab: null,
  });
  // The index the server signs (the example's own money and people for it; the shape is `RECORD-V2.md` 11.6).
  const rank = (exampleRecord().held as Record<string, any>).rank;
  const windowSecs = (exampleRecord().held as Record<string, any>).windows
    .rankSecs as number;
  const at = await chainNow();
  relay.seed(
    event(
      39009,
      RELAY,
      shapeOnlyIndexContent(
        [
          {
            key: project.key,
            a: coordinateOf(project.label),
            launchedAt: at - 3 * windowSecs,
            windowSecs,
            money: rank.money,
            accounts: rank.accounts,
            reached: false,
          },
        ],
        { now: at },
      ),
      [["d", "explore"]],
      at,
    ),
  );
  await page.getByTestId("tab-link-home").click();
  const section = page.getByTestId("home-ranked");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(
    section.getByRole("heading", { name: "Money that stayed" }),
  ).toBeVisible();
  await expect(section).toContainText(NOT_A_RETURN);
  const rows = section.getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Lantern");
  await expect(rows.first()).toContainText("30 days or more by");
  await expect(rows.first().getByRole("link")).toHaveCount(1);
  await expect(section.getByTestId("ranked-footnote")).toContainText(
    "among the projects this server has numbers for",
  );
  await expectAccessible(page, "Home with the ranking");
  // The row opens the project.
  await rows.first().getByRole("link").click();
  await expect(page.getByTestId("project-name")).toHaveText("Lantern");
});

test("by the keyboard alone: Share is reached in the page's own order, the sheet keeps focus inside, and Escape gives it back", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "keyboard", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, { account: w.who.backer, tab: null });
  await expect(page.getByTestId("backing-review")).toBeVisible({
    timeout: 20_000,
  });
  // Tab goes through the page in reading order and reaches Share (the amount box comes before it).
  const seen: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.getAttribute(
          "data-testid",
        ) ?? "",
    );
    seen.push(id);
    if (id === "share-open") break;
  }
  expect(seen.indexOf("backing-amount")).toBeGreaterThanOrEqual(0);
  expect(seen.indexOf("backing-amount")).toBeLessThan(
    seen.indexOf("share-open"),
  );
  expect(seen.indexOf("backing-review")).toBeLessThan(
    seen.indexOf("share-open"),
  );
  expect(seen.at(-1)).toBe("share-open");
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("share-sheet");
  await expect(sheet).toBeVisible();
  // Tab stays inside the open sheet.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          document
            .querySelector('[data-testid="share-sheet"]')
            ?.contains(document.activeElement) ?? false,
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("share-open")).toBeFocused();
});

for (const size of [
  { name: "phone-390", width: 390, height: 844 },
  { name: "desktop-1280", width: 1280, height: 800 },
])
  test(`the page's top and Home with the ranking do not scroll sideways at ${size.name}`, async ({
    browser,
  }) => {
    const w = world.get();
    const project = await launchProject(w, `wide${size.width}`, FOUNDER_NOSTR);
    await backFor(w, project, w.who.backer, 100n);
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    const page = await context.newPage();
    const { relay } = await openMoney(page, w, project, {
      account: w.who.backer,
      tab: null,
    });
    await expect(page.getByTestId("backing-review")).toBeVisible({
      timeout: 20_000,
    });
    await expectNoSidewaysScroll(page, `the project page at ${size.name}`);
    await page.screenshot({
      path: `test-results/pot-screens/page-top-${size.name}.png`,
    });
    const held = exampleRecord().held as Record<string, any>;
    const at = await chainNow();
    relay.seed(
      event(
        39009,
        RELAY,
        shapeOnlyIndexContent(
          [
            {
              key: project.key,
              a: coordinateOf(project.label),
              launchedAt: at - 3 * held.windows.rankSecs,
              windowSecs: held.windows.rankSecs,
              money: held.rank.money,
              accounts: held.rank.accounts,
              reached: false,
            },
          ],
          { now: at },
        ),
        [["d", "explore"]],
        at,
      ),
    );
    await page.getByTestId("tab-link-home").click();
    await expect(page.getByTestId("home-ranked")).toBeVisible({
      timeout: 20_000,
    });
    await expectNoSidewaysScroll(page, `Home at ${size.name}`);
    await context.close();
  });
