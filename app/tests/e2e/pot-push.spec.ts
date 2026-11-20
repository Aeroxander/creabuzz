import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { linkedWalletRecord } from "../helpers/linked-wallet";
import { createMockRelay } from "./mock-relay";
import { RELAY } from "./helpers/money-world";
import { install } from "./helpers/world";

/**
 * Alerts away from the app in a real browser against the mock server (plan sections 6.3 and 7.8). A test browser has no push
 * service, so the page's push manager, notifications and worker registration are a fake that records what the page asks of
 * it; the two calls to the server are caught and read. What is checked is the card: when it is drawn, that nothing is asked
 * of the browser before the press, the sentences, the two signed calls, and turning off.
 */

const ME_KEY = "e1".repeat(32);
const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const KEY = Buffer.from([
  4,
  ...Array.from({ length: 64 }, (_, i) => i + 1),
]).toString("base64url");
const HEADING = "Alerts when you are away";
const EXPLAINED =
  "Get a short message on this device when a task is planned, taken or ended on a project you back. It says nothing about amounts or names. Open the app to read the news.";

interface Fake {
  permission?: NotificationPermission;
  answer?: NotificationPermission;
  /** A browser with no push at all. */
  cannot?: boolean;
}

/** The browser's push pieces, faked in the page and kept across a reload the way a browser keeps them. */
async function fakeBrowser(page: Page, fake: Fake = {}) {
  await page.addInitScript((init) => {
    const kept = JSON.parse(localStorage.getItem("__fakePush") ?? "null");
    const state = {
      permission: kept?.permission ?? init.permission ?? "default",
      answer: init.answer ?? "granted",
      asked: 0,
      subscribed: [] as { userVisibleOnly: boolean; key: number[] }[],
      unsubscribed: 0,
      endpoint: kept?.endpoint ?? (null as string | null),
      key: kept?.key ?? (null as number[] | null),
    };
    (window as unknown as { __push: unknown }).__push = state;
    const keep = () =>
      localStorage.setItem(
        "__fakePush",
        JSON.stringify({
          permission: state.permission,
          endpoint: state.endpoint,
          key: state.key,
        }),
      );
    if (init.cannot) {
      // biome-ignore lint/suspicious/noExplicitAny: removing a browser feature
      delete (window as any).PushManager;
      return;
    }
    const sub = () =>
      state.endpoint
        ? {
            endpoint: state.endpoint,
            options: {
              applicationServerKey: new Uint8Array(state.key ?? []).buffer,
            },
            toJSON: () => ({
              endpoint: state.endpoint,
              keys: { p256dh: "BPdevicekey", auth: "deviceauth" },
            }),
            unsubscribe: async () => {
              state.endpoint = null;
              state.unsubscribed += 1;
              keep();
              return true;
            },
          }
        : null;
    const pushManager = {
      getSubscription: async () => sub(),
      subscribe: async (o: {
        userVisibleOnly: boolean;
        applicationServerKey: Uint8Array;
      }) => {
        const key = Array.from(new Uint8Array(o.applicationServerKey));
        state.subscribed.push({ userVisibleOnly: o.userVisibleOnly, key });
        state.endpoint = `https://fcm.googleapis.com/fcm/send/${Math.random().toString(36).slice(2)}`;
        state.key = key;
        keep();
        return sub();
      },
    };
    const registration = { pushManager };
    (window as unknown as { PushManager: unknown }).PushManager =
      function PushManager() {};
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        get permission() {
          return state.permission;
        },
        requestPermission: async () => {
          state.asked += 1;
          state.permission = state.answer;
          keep();
          return state.answer;
        },
      },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    });
  }, fake);
}

const pushState = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __push: {
            asked: number;
            subscribed: { userVisibleOnly: boolean; key: number[] }[];
            unsubscribed: number;
            endpoint: string | null;
          };
        }
      ).__push,
  );

interface Calls {
  list: { method: string; auth: string | undefined; body: string | null }[];
  status: number;
}

/** The server's two calls: caught, recorded and answered. */
async function serverCalls(page: Page): Promise<Calls> {
  const calls: Calls = { list: [], status: 200 };
  await page.route("**/push/web", async (route) => {
    const request = route.request();
    calls.list.push({
      method: request.method(),
      auth: request.headers().authorization,
      body: request.postData(),
    });
    await route.fulfill({
      status: calls.status,
      contentType: "application/json",
      body: JSON.stringify(
        calls.status === 200 ? { ok: true } : { error: "x" },
      ),
    });
  });
  return calls;
}

/** You, as a person whose account is linked to a wallet (or not), on a server that does or does not say it sends alerts. */
async function openYou(
  page: Page,
  o: { push?: boolean; linked?: boolean; smart?: boolean } = {},
) {
  const relay = createMockRelay();
  if (o.linked !== false)
    relay.seed(linkedWalletRecord(ME_KEY, WALLET) as never);
  await install(page, relay, ME_KEY, { investing: true, relaySelf: RELAY });
  // The server's own information document, in its own words: this is the one place a server says it sends alerts.
  await page.route("**/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({
        name: "Mock server",
        investing: true,
        self: RELAY,
        ...(o.push === false ? {} : { webPush: { publicKey: KEY } }),
        ...(o.smart === undefined ? {} : { smartAccountLinks: o.smart }),
      }),
    }),
  );
  await page.goto("/you");
}

const phone = (browser: import("@playwright/test").Browser) =>
  browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

test("the card is not drawn unless the server says it sends alerts; nothing is asked of the browser by looking", async ({
  browser,
}) => {
  const context = await phone(browser);
  const page = await context.newPage();
  await fakeBrowser(page);
  await serverCalls(page);
  await openYou(page, { push: false });
  await expect(page.getByTestId("you-page")).toBeVisible();
  await expect(page.getByRole("region", { name: HEADING })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByTestId("home-projects")).toBeVisible();
  expect((await pushState(page)).asked).toBe(0);
  await context.close();
});

test("off by default: one sentence says what is sent, the press asks, subscribes and saves the device with a signed call; turning off deletes it", async ({
  browser,
}) => {
  const context = await phone(browser);
  const page = await context.newPage();
  await fakeBrowser(page);
  const calls = await serverCalls(page);
  await openYou(page);
  const card = page.getByRole("region", { name: HEADING });
  await expect(card.getByTestId("push-state")).toHaveText(EXPLAINED);
  await expect(card).toContainText(
    "Alerts may arrive late or not at all. The news on this page is always the full story.",
  );
  await expect(card).toContainText("You can turn alerts off any time.");
  // Nothing was asked of the browser, and nothing sent to the server, by opening the page.
  expect((await pushState(page)).asked).toBe(0);
  expect(calls.list).toHaveLength(0);
  await expectNoSidewaysScroll(page, "You with the alerts card");
  await expectAccessible(page, "You with the alerts card off");

  // The press, by the keyboard alone.
  const turnOn = card.getByRole("button", { name: "Turn on alerts" });
  await turnOn.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("push-state")).toHaveText(
    "Alerts are on for this device.",
  );
  const device = await pushState(page);
  expect(device.asked).toBe(1);
  expect(device.subscribed).toHaveLength(1);
  expect(device.subscribed[0].userVisibleOnly).toBe(true);
  // It subscribed with the server's own key, byte for byte.
  expect(device.subscribed[0].key).toEqual(
    Array.from(Buffer.from(KEY, "base64url")),
  );
  // One signed PUT with the device's subscription and nothing else about the person.
  expect(calls.list).toHaveLength(1);
  expect(calls.list[0].method).toBe("PUT");
  expect(calls.list[0].auth).toMatch(/^Nostr /);
  expect(JSON.parse(calls.list[0].body ?? "{}")).toEqual({
    endpoint: device.endpoint,
    keys: { p256dh: "BPdevicekey", auth: "deviceauth" },
  });
  await expectAccessible(page, "You with the alerts card on");

  // A reload keeps it on: it is what the device and the record of who saved it say.
  await page.reload();
  await expect(
    page.getByRole("region", { name: HEADING }).getByTestId("push-state"),
  ).toHaveText("Alerts are on for this device.");
  expect(calls.list).toHaveLength(1);

  // Off: the browser stops, the server is told to delete this device, and the card says so.
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByTestId("push-note")).toHaveText(
    "Alerts are off. What the server kept for this device is deleted.",
  );
  await expect(
    page.getByRole("button", { name: "Turn on alerts" }),
  ).toBeVisible();
  expect((await pushState(page)).endpoint).toBeNull();
  expect(calls.list).toHaveLength(2);
  expect(calls.list[1].method).toBe("DELETE");
  expect(calls.list[1].auth).toMatch(/^Nostr /);
  expect(JSON.parse(calls.list[1].body ?? "{}")).toEqual({
    endpoint: device.endpoint,
  });
  await context.close();
});

test("a server that does not accept the device: said, and nothing is left on", async ({
  browser,
}) => {
  const context = await phone(browser);
  const page = await context.newPage();
  await fakeBrowser(page);
  const calls = await serverCalls(page);
  calls.status = 503;
  await openYou(page);
  await page.getByRole("button", { name: "Turn on alerts" }).click();
  await expect(page.getByTestId("push-note")).toHaveText(
    "Alerts could not be turned on. Try again.",
  );
  await expect(
    page.getByRole("button", { name: "Turn on alerts" }),
  ).toBeVisible();
  expect((await pushState(page)).endpoint).toBeNull();
  expect((await pushState(page)).unsubscribed).toBe(1);
  await context.close();
});

test("blocked in the browser, a browser that cannot show alerts, and an account the server cannot tie to a wallet each say so, with no way to turn them on", async ({
  browser,
}) => {
  const context = await phone(browser);
  const blocked = await context.newPage();
  await fakeBrowser(blocked, { permission: "denied" });
  await serverCalls(blocked);
  await openYou(blocked);
  await expect(
    blocked.getByText(
      "Alerts are blocked for this site in your browser settings.",
    ),
  ).toBeVisible();
  await expect(
    blocked.getByRole("button", { name: "Turn on alerts" }),
  ).toHaveCount(0);

  const cannot = await context.newPage();
  await fakeBrowser(cannot, { cannot: true });
  await serverCalls(cannot);
  await openYou(cannot);
  await expect(
    cannot.getByText(
      "This browser cannot show alerts. On an iPhone, add the app to your Home Screen first.",
    ),
  ).toBeVisible();
  await expect(
    cannot.getByRole("button", { name: "Turn on alerts" }),
  ).toHaveCount(0);

  const unlinked = await context.newPage();
  await fakeBrowser(unlinked);
  const calls = await serverCalls(unlinked);
  await openYou(unlinked, { linked: false });
  await expect(unlinked.getByTestId("push-needs-link")).toHaveText(
    "To tell which projects you back, the server needs this account confirmed.",
  );
  await expect(
    unlinked.getByRole("button", { name: "Turn on alerts" }),
  ).toHaveCount(0);
  await expect(
    unlinked.getByRole("button", {
      name: "Confirm this account backs the project",
    }),
  ).toBeVisible();
  expect(calls.list).toHaveLength(0);
  await expectAccessible(unlinked, "You with the alerts card needing a link");
  await context.close();
});

test("the person closing the browser's question is not an error, and refusing it ends blocked", async ({
  browser,
}) => {
  const context = await phone(browser);
  const closed = await context.newPage();
  await fakeBrowser(closed, { answer: "default" });
  const calls = await serverCalls(closed);
  await openYou(closed);
  await closed.getByRole("button", { name: "Turn on alerts" }).click();
  await expect.poll(async () => (await pushState(closed)).asked).toBe(1);
  await expect(
    closed.getByRole("button", { name: "Turn on alerts" }),
  ).toBeVisible();
  await expect(closed.getByTestId("push-note")).toHaveCount(0);
  expect(calls.list).toHaveLength(0);

  const denied = await context.newPage();
  await fakeBrowser(denied, { answer: "denied" });
  await serverCalls(denied);
  await openYou(denied);
  await denied.getByRole("button", { name: "Turn on alerts" }).click();
  await expect(
    denied.getByText(
      "Alerts are blocked for this site in your browser settings.",
    ),
  ).toBeVisible();
  await context.close();
});
