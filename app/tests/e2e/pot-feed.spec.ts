// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  backFor,
  NO_CHAIN_WHY,
  UNIT,
  launchProject,
  passTime,
} from "./helpers/live-chain";
import { FOUNDER_NOSTR, liveWorld, openMoney } from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The live feed and "how long you have held it" in a real browser against a real chain (plan section 7.5). The feed is read
 * from the signed record's `feed` key (the example's, moved to the chain's clock, with joins put in so both counts show); the
 * weeks held are read by the page itself from the account's own Transfer logs on the chain and the chain's own block times.
 */

const world = liveWorld();
const NOT_A_RETURN = "This can go up or down. It is not a return.";

/** Hours in which people backed and took out, so both counts and a net are in the record. */
const busy = (content: Record<string, any>) => {
  const hours = (content.feed as Record<string, any>).hours as Record<
    string,
    any
  >[];
  hours[44] = {
    ...hours[44],
    joins: 3,
    tookOut: 0,
    net: { dir: "in", amount: "500000000" },
  };
  hours[46] = {
    ...hours[46],
    joins: 2,
    tookOut: 1,
    net: { dir: "in", amount: "300000000" },
  };
};

test("the feed on a phone: what happened, joins and take-outs at equal weight, the hours behind one press, no names", async ({
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "feedscreen", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await openMoney(page, w, project, {
    account: w.who.stranger,
    tab: null,
    patch: busy,
  });
  const feed = page.getByRole("region", { name: "Lately" });
  await expect(feed).toBeVisible({ timeout: 20_000 });
  await expect(feed).toContainText(NOT_A_RETURN);
  await expect(feed).toContainText(
    "Amounts are rounded to the nearest 100 dollars. No names are shown.",
  );
  // The things that lasted, newest first, five to begin with; one press shows ten more and keeps the reader's place.
  const items = feed.getByTestId("feed-item");
  await expect(items).toHaveCount(5);
  await feed.getByTestId("feed-show-earlier").click();
  await expect(items).toHaveCount(15);
  await expect(items.nth(5)).toBeFocused();

  // Equal weight: the two counts have the same size, weight and colour as the browser draws them.
  const look = (id: string) =>
    feed.getByTestId(id).evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.fontSize, s.fontWeight, s.color, s.fontFamily].join("|");
    });
  expect(await look("feed-joins")).toBe(await look("feed-took-out"));
  await expect(feed.getByTestId("feed-lately")).toContainText(
    /Last 2 days: \d+ backed, \d+ took out\./,
  );
  await expect(feed.getByTestId("feed-net")).toHaveText(
    "About 400 dollars more came in than went out.",
  );

  // The hours are behind a press, reached and opened by the keyboard.
  const press = feed.getByTestId("feed-by-hour");
  await press.focus();
  await page.keyboard.press("Enter");
  await expect(press).toHaveAttribute("aria-expanded", "true");
  const rows = feed.getByTestId("feed-hour");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(/\d+ backed, \d+ took out\./);

  const text = (await feed.textContent()) ?? "";
  expect(text).not.toMatch(/0x[0-9a-f]{4}|npub|volume|price|profit|gain|\$/i);
  await expectNoSidewaysScroll(page, "the feed at 360");
  await expectAccessible(page, "the feed with the hours open");
  await page.screenshot({ path: "test-results/pot-screens/feed-360.png" });
  await context.close();
});

test("a server that sends no feed draws no feed at all", async ({ page }) => {
  const w = world.get();
  const project = await launchProject(w, "nofeed", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, {
    account: w.who.stranger,
    tab: null,
    patch: (content) => {
      delete content.feed;
    },
  });
  await expect(page.getByTestId("project-name")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("top-money-pot")).toBeVisible();
  await expect(page.getByTestId("project-feed")).toHaveCount(0);
});

test("a record past a day old draws no feed, since its amounts are money", async ({
  page,
}) => {
  const w = world.get();
  const old = await launchProject(w, "oldfeed", FOUNDER_NOSTR);
  await backFor(w, old, w.who.backer, 100n);
  await openMoney(page, w, old, {
    account: w.who.stranger,
    tab: null,
    patch: (content) => {
      content.builtAt = (content.builtAt as number) - 2 * 86_400;
    },
  });
  await expect(page.getByTestId("top-money-stale")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("project-feed")).toHaveCount(0);
});

test("the line under Your Shares says how long you have held them, from the chain's own clock", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "weeksheld", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  // Two units and a little pass on the chain (the founder keeps checking in so the project stays live).
  const { checkIn } = await import("./helpers/live-chain");
  for (let i = 0; i < 2; i += 1) {
    await passTime(UNIT);
    await checkIn(w, project);
  }
  await passTime(60);
  await openMoney(page, w, project, { account: w.who.backer });
  const line = page.getByTestId("holding-held-since");
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toHaveText("You have held it for 2 weeks.");
  await expect(line).not.toContainText(/point|badge|earn|reward|streak/i);
  await expectAccessible(page, "Your Shares with the weeks held");
});

test("a stranger who holds nothing sees no weeks line", async ({ page }) => {
  const w = world.get();
  const project = await launchProject(w, "noweeks", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, { account: w.who.stranger });
  await expect(page.getByTestId("holding-none")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("holding-held-since")).toHaveCount(0);
});
