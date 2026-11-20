import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { call } from "../anvil/rpc";
import { walletOf } from "../anvil/pot-chain";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { checkIn, giveDollars } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { timeText } from "../../src/features/money/numbers";
import {
  PUSH_TITLE,
  PUSH_WORDS,
} from "../../src/features/alerts/push/push-words";
import {
  backInApp,
  check,
  dbCount,
  dollarsInASentence,
  NOT_RUNNABLE,
  ok,
  query,
  RUN,
  same,
  secretKeyOf,
  standin,
  startAndLaunch,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(NOT_RUNNABLE !== null, NOT_RUNNABLE ?? "");

/**
 * Step 3, alerts away from the app, joined up (`scripts/pot-full-loop.sh`): the real server with web push switched on from its
 * environment (a key made for this run), a local chain, the app's own build in Chromium, and a local stand-in for a push service.
 * A test browser has no push service, so the page's push manager is a small fake that hands the app the stand-in's own device
 * (its address and keys); everything else is real: the app's signed call that keeps the device, the server's alert maker and
 * sender, the encryption, and the real service worker file (run here as the browser runs it).
 *
 *   A holder backs a project in the app (the last step links their account to the wallet), turns alerts on from You, and the
 *   server keeps one device. The team plans a task. The stand-in receives one message and decrypts it: three keys, no amount and
 *   no name, a verified token. The real worker turns that message into its fixed sentence, and the same news is on You in
 *   the app's longer words. The holder turns alerts off; the next task reaches nobody.
 */

const WHAT = `Translate the guide ${NAME_TAG}`;
const WORKER_SOURCE = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");

/** Run the worker file in a fake scope and give it one push message: what it shows and where a press opens. */
async function whatTheWorkerShows(message: unknown): Promise<{
  title: string;
  body: string;
  url: string;
} | null> {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: {
    title: string;
    options: { body: string; data: { url: string } };
  }[] = [];
  const waits: Promise<unknown>[] = [];
  const scope = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    location: { origin: "http://localhost" },
    registration: {
      showNotification: async (
        title: string,
        options: { body: string; data: { url: string } },
      ) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () => [],
      openWindow: async () => undefined,
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
  };
  const context = vm.createContext({
    self: scope,
    caches: {},
    URL,
    Response,
    Request,
    Object,
    JSON,
    Promise,
  });
  vm.runInContext(WORKER_SOURCE, context);
  handlers.push({
    type: "push",
    data: { json: () => message },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  const first = shown[0];
  return first
    ? {
        title: first.title,
        body: first.options.body,
        url: first.options.data.url,
      }
    : null;
}

/** The browser's push pieces, faked: its device is the stand-in's (address and keys), kept across a reload as a browser keeps it. */
async function fakeBrowser(
  page: Page,
  device: { endpoint: string; keys: { p256dh: string; auth: string } },
) {
  await page.addInitScript((d) => {
    const kept = JSON.parse(localStorage.getItem("__fakePush") ?? "null");
    const state = {
      permission: kept?.permission ?? "default",
      asked: 0,
      subscribed: 0,
      unsubscribed: 0,
      on: kept?.on ?? false,
      key: kept?.key ?? (null as number[] | null),
    };
    (window as unknown as { __push: unknown }).__push = state;
    const keep = () =>
      localStorage.setItem(
        "__fakePush",
        JSON.stringify({
          permission: state.permission,
          on: state.on,
          key: state.key,
        }),
      );
    const sub = () =>
      state.on
        ? {
            endpoint: d.endpoint,
            options: {
              applicationServerKey: new Uint8Array(state.key ?? []).buffer,
            },
            toJSON: () => ({ endpoint: d.endpoint, keys: d.keys }),
            unsubscribe: async () => {
              state.on = false;
              state.unsubscribed += 1;
              keep();
              return true;
            },
          }
        : null;
    const pushManager = {
      getSubscription: async () => sub(),
      subscribe: async (o: { applicationServerKey: Uint8Array }) => {
        state.subscribed += 1;
        state.key = Array.from(new Uint8Array(o.applicationServerKey));
        state.on = true;
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
          state.permission = "granted";
          keep();
          return "granted";
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
  }, device);
}

interface Received {
  path: string;
  message: string | null;
  messageError: string | null;
  vapidError: string | null;
  ttl: string;
  topic: string | null;
}

test("a holder turns alerts on, a planned task reaches the stand-in, the real worker says it in its fixed words, and Turn off stops it", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const w = await worldOnThisChain();
  const holderAccount = w.who.member;
  const workerAccount = w.who.stranger;
  const stopMiner = startMiner();
  const pages: Page[] = [];
  const read = (to: string, data: string) => call(to, data);
  try {
    // The server says it sends alerts, and says nothing else about them.
    const info = (await fetch(`${RUN.relay}/info`, {
      headers: { accept: "application/nostr+json" },
    }).then((r) => r.json())) as { webPush?: { publicKey: string } };
    check(
      typeof info.webPush?.publicKey === "string" &&
        Buffer.from(info.webPush.publicKey, "base64url").length === 65,
      "the server's information carries its push key (65 bytes) because the operator set one",
    );

    // ── a project; the holder backs it in the app ─────────────────────────────────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    const founderWallet = await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const name = `Beacon ${NAME_TAG}`;
    const started = await startAndLaunch(w, founder, name);
    const { link, project, founderPub } = started;
    const ref = link.replace(/^\/p\//, "");
    ok(`the founder started "${name}" and launched it (${link})`);

    const device = await standin<{
      endpoint: string;
      keys: { p256dh: string; auth: string };
    }>("/_devices", {});
    const holder = await phone(browser);
    pages.push(holder);
    await fakeBrowser(holder, device);
    await installAnvilWallet(holder, holderAccount);
    await newPerson(holder, `Hana ${NAME_TAG}`);
    const holderPub = getPublicKey(await secretKeyOf(holder));
    await giveDollars(w, holderAccount);
    await holder.goto(link);
    await backInApp(holder, 300);
    let linked = 0;
    for (let i = 0; i < 40 && linked === 0; i += 1) {
      linked = (await query({ kinds: [37017], authors: [holderPub], limit: 3 }))
        .length;
      if (!linked) await new Promise((r) => setTimeout(r, 500));
    }
    check(
      linked > 0,
      "the holder's Back ended by linking the account to the wallet",
    );
    await waitForRecord(project.key, "the holder's money is in", (n) =>
      n.holders.some(
        (h) => h.account.toLowerCase() === holderAccount.toLowerCase(),
      ),
    );

    await checkIn(w, project);

    // ── the holder turns alerts on from You ───────────────────────────────────────────────────────────────────────
    await holder.goto("/you");
    const card = holder.getByRole("region", {
      name: "Alerts when you are away",
    });
    await expect(card).toBeVisible({ timeout: 30_000 });
    const asked = () =>
      holder.evaluate(
        () => (window as unknown as { __push: { asked: number } }).__push.asked,
      );
    same(await asked(), 0, "viewing the card asked nothing of the browser");
    same(
      dbCount("select count(*) from web_push_subscriptions"),
      0,
      "the server keeps no device yet",
    );
    await card.getByRole("button", { name: "Turn on alerts" }).click();
    await expect(card.getByTestId("push-state")).toHaveText(
      "Alerts are on for this device.",
      { timeout: 30_000 },
    );
    same(
      dbCount("select count(*) from web_push_subscriptions"),
      1,
      "the app's signed call kept exactly one device on the server",
    );
    ok(
      "the holder turned alerts on from You: the browser was asked once, the server keeps the one device",
    );

    // ── the team plans a task; a worker takes it ──────────────────────────────────────────────────────────────────
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    await founder.getByTestId("task-new").click();
    await founder.getByTestId("task-what").fill(WHAT);
    await founder.getByTestId("task-dollars").fill("6");
    await founder.getByTestId("task-post").click();
    await expect(founder.getByTestId("task-card").first()).toContainText(WHAT, {
      timeout: 20_000,
    });
    const [taskRecord] = await query({
      kinds: [47003],
      "#a": [`37001:${founderPub}:${started.projectId}`],
      "#task-part": ["task"],
      limit: 1,
    });
    const worker = await phone(browser);
    pages.push(worker);
    await installAnvilWallet(worker, workerAccount);
    await newPerson(worker, `Wes ${NAME_TAG}`);
    await worker.goto(link);
    await worker.getByTestId("tab-tasks").click();
    await worker.getByTestId("task-take").click();
    for (let i = 0; i < 40; i += 1) {
      const steps = await query({
        kinds: [47003],
        "#e": [taskRecord.id],
        "#task-part": ["take"],
        limit: 2,
      });
      if (steps.length) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    await expect(founder.getByTestId("door-plan")).toHaveText(
      "Plan the pay of 6 dollars",
      { timeout: 30_000 },
    );
    const promptsBefore = founderWallet.prompts;
    await founder.getByTestId("door-plan").click();
    await expect(founder.getByTestId("plan-sheet")).toBeVisible();
    await founder.getByTestId("sheet-confirm").click();
    await expect(founder.getByTestId("plan-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      founderWallet.prompts - promptsBefore,
      1,
      "planning the pay asked the wallet once",
    );
    const planned = await reads.readTask(
      read,
      await waitForBook(project.key),
      1n,
    );
    same(planned?.state, "announced", "the chain holds the plan");

    // ── the stand-in receives one message; it decrypts to three keys ──────────────────────────────────────────────
    let received: Received[] = [];
    for (let i = 0; i < 90 && received.length === 0; i += 1) {
      received = await standin<Received[]>("/_received");
      if (received.length === 0) await new Promise((r) => setTimeout(r, 1000));
    }
    check(
      received.length === 1,
      `the push service received one message (${received.length})`,
    );
    const got = received[0];
    same(
      got.messageError,
      null,
      "the stand-in decrypted the message with the device's own keys",
    );
    same(got.vapidError, null, "the operator's token on the message verifies");
    const message = JSON.parse(got.message ?? "null") as Record<
      string,
      unknown
    >;
    same(
      JSON.stringify(Object.keys(message).sort()),
      JSON.stringify(["k", "r", "v"]),
      "the message has three keys and nothing else: no amount, no name, no date",
    );
    same(message.k, "planned", "the message says a task was planned");
    same(
      message.r,
      ref,
      "the message names the project by the link people already share",
    );
    check(
      (got.message ?? "").length < 200 &&
        got.ttl === "86400" &&
        got.topic?.length === 32,
      "the message is under 200 bytes, lives a day, and carries a 32-character topic",
    );
    same(
      got.path,
      new URL(device.endpoint).pathname,
      "it went to the holder's device and no other",
    );

    // ── the real worker turns it into its fixed sentence; the same news is on You in the app's own words ─────────
    const shown = await whatTheWorkerShows(message);
    if (!shown) throw new Error("the worker showed nothing for a good message");
    same(shown.title, PUSH_TITLE, "the device's alert has the fixed title");
    same(
      shown.body,
      PUSH_WORDS.planned,
      "the device's alert is the fixed sentence for a planned task",
    );
    same(
      shown.url,
      `/p/${ref}`,
      "pressing the alert opens the project the message names",
    );
    check(
      (await whatTheWorkerShows({ ...message, k: "paid" })) === null &&
        (await whatTheWorkerShows({ ...message, extra: "Send money to x" }))
          ?.body === PUSH_WORDS.planned,
      "the worker drops a kind it does not know and never shows anything the message adds",
    );
    await holder.goto("/you");
    const row = holder.getByTestId("news-row").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const most = dollarsInASentence(BigInt(6_000_000));
    await expect(row.getByTestId("news-sentence")).toContainText(
      `${name}: the team plans to pay up to ${most} dollars for “${WHAT}”, from ${timeText(planned?.noticeEnd ?? 0)}.`,
    );
    const urgent = (await row.getByTestId("news-urgent").textContent()) ?? "";
    check(
      urgent.includes("You can take your money out") &&
        PUSH_WORDS.planned.includes("You can take your money out"),
      "the in-app news and the device's alert are the same news in two lengths: both end with the way out",
    );
    ok(
      "the alert on the device carries the kind and the link; the amounts, the name and the date stay in the app",
    );

    // ── Turn off: the server deletes what it kept; the next task reaches nobody ──────────────────────────────────
    await holder.goto("/you");
    const card2 = holder.getByRole("region", {
      name: "Alerts when you are away",
    });
    await card2.getByRole("button", { name: "Turn off" }).click();
    await expect(card2.getByTestId("push-note")).toHaveText(
      "Alerts are off. What the server kept for this device is deleted.",
      { timeout: 30_000 },
    );
    same(
      dbCount("select count(*) from web_push_subscriptions"),
      0,
      "after Turn off the server keeps no device",
    );
    // A second plan, made on the chain by the team (the same call the Tasks tab sends): the server makes its alert and nobody is sent it.
    const before = dbCount("select count(*) from web_push_alerts");
    await standin("/_reset", {});
    await walletOf(w.who.founder).sendCalls(
      [
        pot.announceTaskCall({
          treasury: project.treasury,
          what: `0x${"ab".repeat(32)}`,
          payee: workerAccount,
          maxDollars: 2_000_000n,
          shareBps: 100,
        }),
      ],
      31337,
    );
    for (
      let i = 0;
      i < 60 && dbCount("select count(*) from web_push_alerts") === before;
      i += 1
    )
      await new Promise((r) => setTimeout(r, 1000));
    check(
      dbCount("select count(*) from web_push_alerts") > before,
      "the server made an alert for the second plan",
    );
    await new Promise((r) => setTimeout(r, 12_000));
    same(
      (await standin<Received[]>("/_received")).length,
      0,
      "after Turn off the second plan reached nobody",
    );
    same(
      dbCount("select count(*) from web_push_outbox"),
      0,
      "and the server wrote no send for it",
    );
  } finally {
    stopMiner();
    for (const p of pages) await p.context().close();
  }
});

/** The task book of a project, from its Treasury (the chain's own view). */
async function waitForBook(key: string): Promise<string> {
  const record = await waitForRecord(key, "the task book is known", (n) =>
    Boolean(n.tasks?.book),
  );
  return record.content.tasks?.book ?? "";
}
