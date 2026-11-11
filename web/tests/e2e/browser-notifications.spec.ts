import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
} from "./helpers/project-world";

/**
 * Browser notifications: nothing asks the browser for permission on arrival; after following a project a small
 * offer appears, and only its button asks. With them on, a notification is shown when the count of new things goes
 * up while the page is hidden, and it names a count and nothing else. One switch on the Notifications page turns
 * them off and on. There is no push server.
 */

const ME_KEY = "a7".repeat(32);
const ME = pubkeyOf(ME_KEY);
const FOUNDER = pubkeyOf("a8".repeat(32));
const CHANNEL = "0f0f0f0f-1111-2222-3333-555555555555";

/** A stand-in for the browser's Notification: records what was asked and shown, and answers as `answer` says. */
async function fakeNotifications(
  page: Page,
  start: "default" | "granted" | "denied",
  answer: "granted" | "denied" = "granted",
) {
  await page.addInitScript(
    ([first, reply]) => {
      // Kept across page loads, as the browser keeps its permission: what was asked, shown and answered.
      const get = (key: string, fallback: string) =>
        sessionStorage.getItem(`fake.${key}`) ?? fallback;
      const set = (key: string, value: string) =>
        sessionStorage.setItem(`fake.${key}`, value);
      const w = window as unknown as Record<string, unknown>;
      w.__hidden = false;
      class Fake {
        static get permission() {
          return get("permission", first);
        }
        static requestPermission() {
          set("asked", String(Number(get("asked", "0")) + 1));
          set("permission", reply);
          return Promise.resolve(reply);
        }
        onclick: (() => void) | null = null;
        constructor(title: string, options?: { body?: string }) {
          const shown = JSON.parse(get("shown", "[]")) as unknown[];
          shown.push({ title, body: options?.body });
          set("shown", JSON.stringify(shown));
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: Fake,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => w.__hidden,
      });
    },
    [start, answer] as const,
  );
}

const asked = (page: Page) =>
  page.evaluate(() => Number(sessionStorage.getItem("fake.asked") ?? "0"));
const shown = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("fake.shown") ?? "[]") as {
        title: string;
        body: string;
      }[],
  );
const hide = (page: Page, hidden: boolean) =>
  page.evaluate((value) => {
    (window as unknown as { __hidden: boolean }).__hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

function seed() {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    event(0, ME, { name: "Mia", display_name: "Mia" }, [], now() - 9 * DAY),
  );
  relay.seed(projectRecord(FOUNDER, "nebula", "Nebula", now() - DAY));
  return relay;
}

const mention = (id: number) =>
  event(
    9,
    FOUNDER,
    "a private word nobody else should read",
    [
      ["h", CHANNEL],
      ["p", ME],
    ],
    now() + id,
  );

test("nothing asks on arrival; after following a project the offer's button asks, and news while hidden is announced by count", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = seed();
  await fakeNotifications(page, "default");
  await install(page, relay, ME_KEY);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/discover");
  await expect(page.getByTestId("user-chip")).toBeVisible();
  // Arriving, and moving around, asks for nothing and offers nothing.
  await expect(page.getByTestId("notify-offer")).toHaveCount(0);
  expect(await asked(page)).toBe(0);

  // Following a project is the moment it is offered. The offer itself still asks the browser nothing.
  await page.goto(`/p/nebula-${FOUNDER.slice(0, 16)}`);
  const follow = page.getByTestId("scorecard-follow");
  await expect(follow).toBeEnabled({ timeout: 30_000 });
  await follow.click();
  const offer = page.getByTestId("notify-offer");
  await expect(offer).toBeVisible();
  expect(await asked(page)).toBe(0);
  await expectAccessible(page, "the offer to turn notifications on");
  await offer.getByTestId("notify-offer-on").click();
  await expect(offer).toHaveCount(0);
  expect(await asked(page)).toBe(1);
  expect(
    relay.events.some(
      (e) =>
        e.kind === 10003 &&
        e.tags.some((t) => t[1] === coordOf(FOUNDER, "nebula")),
    ),
  ).toBe(true);

  // Something new arrives while the page is in view: the bell counts, and no notification is shown.
  const bell = page
    .getByTestId("app-nav-inbox")
    .getByTestId("social-nav-notifications");
  relay.seed(mention(1));
  await expect(bell.getByTestId("social-unread")).toHaveText("1", {
    timeout: 40_000,
  });
  expect(await shown(page)).toEqual([]);

  // Hidden, and another arrives: one notification, with a count and none of the message's words.
  await hide(page, true);
  relay.seed(mention(2));
  await expect
    .poll(() => shown(page), { timeout: 40_000 })
    .toEqual([{ title: "Creaton", body: "2 new notifications" }]);
  // Coming back and leaving again does not replay it.
  await hide(page, false);
  await hide(page, true);
  await page.waitForTimeout(500);
  expect(await shown(page)).toHaveLength(1);
  await hide(page, false);

  // The one switch: off, and nothing is shown for the next one.
  await bell.click();
  const toggle = page.getByTestId("notify-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expectAccessible(page, "Notifications with the browser switch");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("notify-toggle-state")).toContainText("Off.");
  await page.goto("/discover");
  await hide(page, true);
  relay.seed(mention(3));
  await expect(bell.getByTestId("social-unread")).toHaveText("1", {
    timeout: 40_000,
  });
  expect(await shown(page)).toHaveLength(1);
  // Having chosen, the offer does not come back after another follow-worthy action.
  await expect(page.getByTestId("notify-offer")).toHaveCount(0);
});

test("when the browser says no, the page says so and the switch explains how to allow it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = seed();
  await fakeNotifications(page, "default", "denied");
  await install(page, relay, ME_KEY);
  await page.goto(`/p/nebula-${FOUNDER.slice(0, 16)}`);
  const follow = page.getByTestId("scorecard-follow");
  await expect(follow).toBeEnabled({ timeout: 30_000 });
  await follow.click();
  await page.getByTestId("notify-offer-on").click();
  await expect(page.getByTestId("notify-offer-blocked")).toContainText(
    "didn't allow notifications",
  );
  await page.goto("/social/notifications");
  const toggle = page.getByTestId("notify-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeDisabled();
  await expect(page.getByTestId("notify-toggle-state")).toContainText(
    "blocking notifications",
  );
});

test("the switch turns them on from the Notifications page, asking the browser once; No thanks is remembered", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = seed();
  await fakeNotifications(page, "default");
  await install(page, relay, ME_KEY);
  await page.goto(`/p/nebula-${FOUNDER.slice(0, 16)}`);
  const follow = page.getByTestId("scorecard-follow");
  await expect(follow).toBeEnabled({ timeout: 30_000 });
  await follow.click();
  await page.getByTestId("notify-offer-no").click();
  await expect(page.getByTestId("notify-offer")).toHaveCount(0);
  expect(await asked(page)).toBe(0);
  // Unfollow and follow again: the offer stays away.
  await follow.click();
  await expect(follow).toHaveText("Follow");
  await follow.click();
  await expect(follow).toHaveText("Following");
  await expect(page.getByTestId("notify-offer")).toHaveCount(0);

  await page.goto("/social/notifications");
  const toggle = page.getByTestId("notify-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await asked(page)).toBe(1);
  await expect(page.getByTestId("notify-toggle-state")).toContainText("On.");
});
