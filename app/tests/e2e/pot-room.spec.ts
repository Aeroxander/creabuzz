// biome-ignore-all lint/suspicious/noExplicitAny: records are read as loose JSON, the way the page meets them
import { expect, type Page, test } from "@playwright/test";
import { call } from "../anvil/rpc";
import { walletOf } from "../anvil/pot-chain";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { accountOf, linkedWalletRecord } from "../helpers/linked-wallet";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { balanceOf } from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import {
  backFor,
  chainNow,
  giveDollars,
  type LiveProject,
  type LiveWorld,
  launchProject,
  NO_CHAIN_WHY,
  passTime,
  UNIT,
} from "./helpers/live-chain";
import {
  FOUNDER_KEY,
  FOUNDER_NOSTR,
  liveWorld,
  openServer,
  pageOf,
  seedServer,
  syncClock,
} from "./helpers/live-browser";
import { installAnvilWallet } from "./helpers/live-wallet";
import { createMockRelay } from "./mock-relay";
import { event, now, profile, pubkeyOf } from "./helpers/world";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The holder room in a real browser against a real chain (plan sections 4.7 and 7.6). The page reads the chain through the
 * person's own wallet, exactly as it does for a person; the server is the mock, with one stand-in rule in place of the real
 * one: it lets a write into the room only from the accounts in `holders`, with the real server's own sentence. What the room
 * offers, and what it says, come from the page.
 */

const world = liveWorld();
const HOLDER_KEY = "b8".repeat(32);
const HOLDER = pubkeyOf(HOLDER_KEY);
const SECOND_KEY = "b9".repeat(32);
const SECOND = pubkeyOf(SECOND_KEY);
const NOT_YET =
  "restricted: only people who back this project can write in its room. If you just backed it, wait about a minute and try again";

/** What the real server's room rule does, for these specs: accounts in `holders` may write, nobody else. */
const rule =
  (holders: Set<string>) =>
  (e: { kind: number; pubkey: string; tags: string[][] }) =>
    e.tags.some((t) => t[0] === "t" && String(t[1]).startsWith("room:")) &&
    !holders.has(e.pubkey)
      ? NOT_YET
      : null;

interface Open {
  /** The wallet's account; null puts no wallet in the page. */
  account: string | null;
  /** The account's key on the server, or null for nobody signed in. */
  key: string | null;
  holders?: Set<string>;
  /** The account's wallet link is on the server. */
  linked?: boolean;
  /** Steps the page remembers as this device's own (Back and Take out). */
  history?: { account: string; kind: "take-out"; at: number }[];
}

async function openRoom(
  page: Page,
  w: LiveWorld,
  project: LiveProject,
  o: Open,
) {
  const holders = o.holders ?? new Set<string>();
  const relay = createMockRelay({ refuse: rule(holders) });
  await seedServer(relay, w, project);
  relay.seed(profile(HOLDER, "Hana Holder", "Backs lamps."));
  relay.seed(profile(SECOND, "Sam Second"));
  const roomTags = [
    ["a", project.coordinate],
    ["t", `room:${project.key}`],
  ];
  relay.seed(
    event(
      1,
      HOLDER,
      "The lids are painted. Friday works for me.",
      roomTags,
      now() - 600,
    ),
  );
  relay.seed(
    event(1, HOLDER, "Does anyone want to test a lamp?", roomTags, now() - 300),
  );
  relay.seed(
    event(
      47003,
      FOUNDER_NOSTR,
      {
        title: "Week 3",
        body: "We shipped the lids and started on the wiring.",
      },
      [["a", project.coordinate]],
      now() - 900,
    ),
  );
  if (o.linked && o.key && o.account)
    relay.seed(linkedWalletRecord(o.key, o.account) as never);
  // The holder's own link, so the team's stop can name the wallet.
  relay.seed(linkedWalletRecord(HOLDER_KEY, w.who.backer) as never);
  await openServer(page, relay, o.key);
  const wallet = await installAnvilWallet(page, o.account, {
    connected: true,
  });
  // Something new in the room shows as a dot on its tab until the room has been looked at.
  const dot = page.getByTestId("tab-room-new");
  if (o.history)
    await page.addInitScript(
      ([steps, key]) => {
        const all: Record<string, unknown[]> = {};
        for (const s of steps as {
          account: string;
          kind: string;
          at: number;
        }[]) {
          const account = s.account.toLowerCase();
          if (!all[account]) all[account] = [];
          all[account].push({
            kind: s.kind,
            project: key,
            at: s.at,
            dollars: "1000000",
            shares: "1",
            txHash: `0x${"ab".repeat(32)}`,
          });
        }
        localStorage.setItem("creaton.pot.history", JSON.stringify(all));
      },
      [o.history, project.key] as const,
    );
  await syncClock(page);
  await page.goto(pageOf(project.label));
  await expect(dot).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("tab-room").click({ timeout: 20_000 });
  await expect(page.getByTestId("room")).toBeVisible({ timeout: 20_000 });
  return { relay, holders, wallet };
}

const phone = {
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const composer = (page: Page) =>
  page.getByLabel("Write to the people who back this");

test("a person who does not back the project reads the room and is told what to do, on a phone", async ({
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomread", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await openRoom(page, w, project, {
    account: w.who.stranger,
    key: "c3".repeat(32),
  });
  const room = page.getByTestId("room");
  await expect(page.getByTestId("room-read-line")).toHaveText(
    "Anyone can read this room. Only people who back the project can write here.",
  );
  await expect(room).toContainText("Posts and votes are public.");
  await expect(room.getByTestId("room-list")).toContainText(
    "The lids are painted. Friday works for me.",
  );
  await expect(room.getByTestId("room-notice-pinned")).toContainText(
    "From the team, pinned",
  );
  await expect(room.getByTestId("room-notice-pinned")).toContainText("Week 3");
  await expect(room).toContainText(
    "Only people who back this project can write here.",
  );
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByTestId("room-like")).toHaveCount(0);
  await expectNoSidewaysScroll(page, "the room at 360");
  await expectAccessible(
    page,
    "the room for someone who does not back the project",
  );
  // The one thing to do: Back takes them to the Back box, and its amount is ready to type in.
  await page.getByRole("button", { name: "Back this project" }).first().click();
  await expect(page.getByTestId("backing-amount")).toBeFocused();
  await context.close();
});

test("a visitor with no account and no wallet reads the same room", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomvisitor", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openRoom(page, w, project, { account: null, key: null });
  await expect(page.getByTestId("room-list")).toContainText(
    "Does anyone want to test a lamp?",
  );
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByTestId("room")).toContainText(
    "Only people who back this project can write here.",
  );
});

test("a holder writes, likes and answers, by keyboard and by touch, and the room tags every one", async ({
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomwrite", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  const { relay } = await openRoom(page, w, project, {
    account: w.who.backer,
    key: HOLDER_KEY,
    linked: true,
    holders: new Set([HOLDER]),
  });
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("room-public-line")).toHaveText(
    "Posts and votes are public.",
  );
  await expect(
    page.getByText("The team can remove posts. Be kind."),
  ).toBeVisible();
  await expectAccessible(page, "the room for a holder");
  // Keyboard: type, Enter makes a new line, Control+Enter posts.
  await box.focus();
  await page.keyboard.type("Saturday works too.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Bring a ladder.");
  await page.keyboard.press("Control+Enter");
  const posted = page
    .getByTestId("room-list")
    .getByText("Saturday works too.", { exact: false });
  await expect(posted).toBeVisible({ timeout: 20_000 });
  const sent = relay.events.find(
    (e: any) => e.kind === 1 && String(e.content).startsWith("Saturday"),
  );
  expect(sent?.content).toBe("Saturday works too.\nBring a ladder.");
  expect(sent?.tags).toContainEqual(["a", project.coordinate]);
  expect(sent?.tags).toContainEqual(["t", `room:${project.key}`]);
  // Touch: the like and the answer are named with the author.
  const first = page
    .getByTestId("room-post")
    .filter({ hasText: "Does anyone want to test a lamp?" });
  const like = first.getByRole("button", { name: /^Like Hana Holder's post/ });
  await like.tap();
  await expect(like).toHaveAttribute("aria-pressed", "true");
  const liked = relay.events.find((e: any) => e.kind === 7);
  expect(liked?.tags).toContainEqual(["t", `room:${project.key}`]);
  await first.getByRole("button", { name: /^Reply to Hana Holder/ }).tap();
  const answer = first.getByLabel("Reply to Hana Holder");
  await answer.fill("I will.");
  await first.getByRole("button", { name: "Reply", exact: true }).tap();
  await expect(first.getByLabel("Reply to Hana Holder")).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(
    first.getByRole("region", { name: "Replies to Hana Holder" }),
  ).toContainText("I will.", { timeout: 20_000 });
  const reply = relay.events.find(
    (e: any) => e.kind === 1 && e.content === "I will.",
  );
  expect(
    reply?.tags.filter((t: string[]) => t[0] === "e").length,
  ).toBeGreaterThan(0);
  expect(reply?.tags).toContainEqual(["t", `room:${project.key}`]);
  await expectNoSidewaysScroll(page, "the room with posts at 360");
  await expectAccessible(page, "the room with an answer and a like");
  // None of it is in the project's updates.
  await page.getByTestId("tab-updates").click();
  await expect(page.getByText("Saturday works too.")).toHaveCount(0);
  // The room was looked at: its dot is gone.
  await expect(page.getByTestId("tab-room-new")).toHaveCount(0);
  await context.close();
});

test("Back ends by linking the account, so the room opens for a person who has just backed, with no extra screen", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomafterback", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const { relay, holders, wallet } = await openRoom(page, w, project, {
    account: w.who.second,
    key: SECOND_KEY,
  });
  // Before: nothing held, nothing linked, and the room says how to join.
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByTestId("room")).toContainText(
    "Only people who back this project can write here.",
  );
  await page.getByRole("button", { name: "Back this project" }).first().click();
  await giveDollars(w, w.who.second);
  const amount = page.getByTestId("backing-amount");
  await expect(amount).toBeFocused();
  await amount.fill("25");
  await page.getByTestId("backing-review").click();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
  // The last step of Back: the account is linked to the wallet that made it, and the room's composer is there.
  await expect
    .poll(
      () =>
        relay.events.filter((e: any) => e.kind === 37017 && e.pubkey === SECOND)
          .length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const link = relay.events.find(
    (e: any) => e.kind === 37017 && e.pubkey === SECOND,
  );
  expect(link?.tags).toContainEqual(["d", w.who.second.toLowerCase()]);
  expect(wallet.sent).toHaveLength(1);
  // The server reads the Back a few blocks later.
  holders.add(SECOND);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await composer(page).fill("Just backed, and I can write.");
  await page.getByTestId("room-composer-send").click();
  await expect(page.getByTestId("room-list")).toContainText(
    "Just backed, and I can write.",
    { timeout: 20_000 },
  );
});

test("a server that has not caught up with a Back is told apart from a refusal: the words are kept and it is tried once more by itself", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomnotyet", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await page.clock.install({ time: Date.now() });
  const holders = new Set<string>();
  const { relay } = await openRoom(page, w, project, {
    account: w.who.backer,
    key: HOLDER_KEY,
    linked: true,
    holders,
  });
  const box = composer(page);
  await box.fill("I just backed it.");
  await page.getByTestId("room-composer-send").click();
  await expect(page.getByTestId("room-refusal")).toHaveText(
    "Not ready yet. Try again in a minute.",
  );
  await expect(box).toHaveValue("I just backed it.");
  expect(relay.events.some((e: any) => e.content === "I just backed it.")).toBe(
    false,
  );
  // The server has read the Back by the time the page tries again.
  holders.add(HOLDER);
  await page.clock.fastForward(31_000);
  await expect(
    page.getByTestId("room-list").getByText("I just backed it."),
  ).toBeVisible({ timeout: 20_000 });
  await expect(box).toHaveValue("");
});

test("a person who took out writes for one unit more and then reads only, by the chain's own clock", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomleaver", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  const read = (to: string, data: string) => call(to, data);
  const shares = await balanceOf(read, project.shares, w.who.second);
  await walletOf(w.who.second).sendCalls(
    [
      pot.leaveCall({
        treasury: project.treasury,
        shares,
        minCash: 0n,
        to: w.who.second,
      }),
    ],
    31337,
  );
  expect(await balanceOf(read, project.shares, w.who.second)).toBe(0n);
  const tookOut = await chainNow();
  await openRoom(page, w, project, {
    account: w.who.second,
    key: SECOND_KEY,
    linked: true,
    holders: new Set([SECOND]),
    history: [{ account: w.who.second, kind: "take-out", at: tookOut }],
  });
  await expect(page.getByTestId("room-grace")).toContainText("You took out");
  await expect(page.getByTestId("room-grace")).toContainText(
    "then this room is read only for you.",
  );
  await expect(composer(page)).toBeVisible();
  // One unit and a little pass on the chain: the same person, on a page that agrees what day it is, can only read.
  await passTime(UNIT + 120);
  await syncClock(page);
  await page.reload();
  await page.getByTestId("tab-room").click({ timeout: 20_000 });
  await expect(page.getByTestId("room-read-line")).toBeVisible({
    timeout: 20_000,
  });
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByTestId("room")).toContainText(
    "Only people who back this project can write here.",
  );
});

test("the team removes a post with a reason, stops a person writing by their wallet, and sets perks without losing the record", async ({
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "roomteam", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  const { relay } = await openRoom(page, w, project, {
    account: w.who.founder,
    key: FOUNDER_KEY,
    linked: true,
  });
  const mine = page
    .getByTestId("room-post")
    .filter({ hasText: "Does anyone want to test a lamp?" });
  await mine
    .getByRole("button", { name: "More actions for Hana Holder's post" })
    .tap();
  await page.getByRole("button", { name: "Remove this post" }).tap();
  const sheet = page.getByTestId("remove-sheet");
  await sheet
    .getByLabel("Say why. Everyone can see the reason.")
    .fill("Off topic");
  await expectAccessible(page, "the remove sheet");
  await sheet.getByRole("button", { name: "Remove" }).tap();
  await expect
    .poll(() => relay.events.filter((e: any) => e.kind === 9005).length)
    .toBe(1);
  const removal = relay.events.find((e: any) => e.kind === 9005);
  expect(removal?.tags.map((t: string[]) => t[0]).sort()).toEqual([
    "e",
    "public_reason",
  ]);
  expect(removal?.tags).toContainEqual(["public_reason", "Off topic"]);
  // Stop a person writing: their linked wallet is named, so a new key on it is stopped too.
  await mine
    .getByRole("button", { name: "More actions for Hana Holder's post" })
    .tap();
  await page
    .getByRole("button", { name: "Stop Hana Holder writing here" })
    .tap();
  await page.getByTestId("mute-sheet").getByLabel("7 days").check();
  await page.getByRole("button", { name: "Stop writing" }).tap();
  await expect
    .poll(
      () =>
        relay.events.filter((e: any) =>
          e.tags?.some((t: string[]) => t[0] === "room-mute"),
        ).length,
    )
    .toBe(1);
  const stop = relay.events.find((e: any) =>
    e.tags?.some((t: string[]) => t[0] === "room-mute"),
  );
  expect(stop?.tags).toContainEqual(["room-mute", HOLDER]);
  expect(stop?.tags).toContainEqual([
    "room-mute-wallet",
    w.who.backer.toLowerCase(),
  ]);
  // Perks: the record keeps every other tag.
  const before = relay.events.find((e: any) => e.kind === 37001);
  await page.getByRole("button", { name: "Add perks" }).tap();
  const perks = page.getByTestId("perks-sheet");
  await perks
    .getByLabel("What do people who back this get?")
    .fill("Early looks at what we make.");
  await expectAccessible(page, "the perks sheet");
  await perks.getByRole("button", { name: "Save" }).tap();
  await expect
    .poll(
      () =>
        relay.events.filter(
          (e: any) =>
            e.kind === 37001 && e.tags.some((t: string[]) => t[0] === "perks"),
        ).length,
    )
    .toBe(1);
  const after = relay.events.find(
    (e: any) =>
      e.kind === 37001 && e.tags.some((t: string[]) => t[0] === "perks"),
  );
  expect(after?.tags.filter((t: string[]) => t[0] !== "perks")).toEqual(
    before?.tags,
  );
  await expect(page.getByTestId("room-perks")).toContainText(
    "Early looks at what we make.",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("room-perks")).toContainText(
    "They are not money and not a promise of a return.",
  );
  await context.close();
});

void accountOf;
