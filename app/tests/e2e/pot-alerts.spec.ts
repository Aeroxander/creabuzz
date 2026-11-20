import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  backFor,
  chainNow,
  checkIn,
  launchProject,
  NO_CHAIN_WHY,
  UNIT,
  type LiveProject,
  type LiveWorld,
} from "./helpers/live-chain";
import {
  FOUNDER_NOSTR,
  liveWorld,
  openServer,
  pageOf,
  seedServer,
  syncClock,
} from "./helpers/live-browser";
import { installAnvilWallet } from "./helpers/live-wallet";
import {
  noticeSecs,
  planOnChain,
  sendBackOnChain,
  seedTaskRecord,
  takeOnChain,
  taskOnChain,
  WHAT,
  WORKER,
} from "./helpers/live-plans";
import { profile, type Relay } from "./helpers/world";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * News about a person's projects, from the signed record, on a real local chain: a holder who opens the app finds what the team
 * planned on You (with the day the money can first move and a way to take it out), the dot on You counts what they have not
 * read and falls when they read it, a new step of the same task is news again, a holder who was away finds the plan still there
 * when the app's clock has moved on, and a person who holds nothing has no news but still reads the strip on the project page.
 * Phone first (390 px, then 360 px).
 */

const world = liveWorld();
const HOLDER_KEY = "a4".repeat(32);
const PHONE_360 = { width: 360, height: 780 };
const USD = 10;

interface Scene {
  w: LiveWorld;
  project: LiveProject;
  relay: Relay;
  server: Awaited<ReturnType<typeof seedServer>>;
  taskId: string;
  /** The account that holds Shares in the project. */
  holder: string;
}

/** A project one account holds, with the team's task record and its plan on the chain, read by the server. */
async function scene(
  label: string,
  who: (w: LiveWorld) => string = (w) => w.who.second,
  dollars = 300n,
): Promise<Scene> {
  const w = world.get();
  const project = await launchProject(w, label, FOUNDER_NOSTR);
  // Each account has the 1,000 play dollars of its faucet for the whole file, so a spec spends what it needs.
  await backFor(w, project, who(w), dollars);
  await checkIn(w, project);
  const relay = createMockRelay();
  // The server lists the holder, as it does from the Treasury's events.
  const server = await seedServer(relay, w, project, {
    tasks: true,
    holders: [who(w)],
  });
  relay.seed(profile(WORKER, "Sam Stranger"));
  const taskId = seedTaskRecord(relay, project, w.who.stranger, USD);
  await planOnChain(w, project, taskId, w.who.stranger, USD);
  await server.republish();
  return { w, project, relay, server, taskId, holder: who(w) };
}

/** A phone for the holder: signed in with their key, the wallet on `account`, on `path`. */
async function holder(
  page: Page,
  s: Scene,
  path: string,
  account: string | null = s.holder,
) {
  await openServer(page, s.relay, HOLDER_KEY);
  const wallet = await installAnvilWallet(page, account);
  await syncClock(page);
  await page.goto(path);
  return wallet;
}

test("a holder opens You and reads what the team planned, with the day money can first move, and the dot falls once it is read", async ({
  page,
}) => {
  const s = await scene("newsplan");
  const notice = await noticeSecs(s.project);
  expect(notice).toBeGreaterThan(UNIT);
  await holder(page, s, "/you");

  const section = page.getByTestId("news-section");
  await expect(section).toBeVisible({ timeout: 20_000 });
  const row = page.getByTestId("news-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The sentence: the project, how much at most, the team's own words for the task, and the day it can first be taken.
  await expect(row).toContainText(
    `the team plans to pay up to ${USD} dollars for “${WHAT}”, from `,
  );
  await expect(row).toContainText("You can take your money out before then.");
  await expect(page.getByTestId("news-urgent")).toContainText(
    "You can take your money out before ",
  );
  await expect(section.getByTestId("news-play-money")).toContainText(
    "play money",
  );
  await expect(section.getByTestId("news-week")).toContainText(
    "open the app at least every 7 days",
  );
  // The list, its one link to the project and the button that takes out, are named for a screen reader.
  await expect(section.getByRole("list")).toBeVisible();
  await expect(row.getByRole("link")).toHaveCount(1);
  await expect(
    section.getByRole("button", { name: /^Take out of .* before / }),
  ).toBeVisible();
  await expectAccessible(page, "News about your projects, 390 px");
  await page.setViewportSize(PHONE_360);
  await expectNoSidewaysScroll(page, "News about your projects, 360 px");

  // What was listed is read: the dot on You is not lit after the list was drawn.
  await expect(page.getByTestId("you-badge")).toHaveCount(0);
  // The button opens the project on its Money tab.
  await section
    .getByRole("button", { name: /^Take out of .* before / })
    .click();
  await expect(page.getByRole("tab", { name: "Money" })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 20_000 },
  );
  // The strip above the tabs says the same, and offers the holder the same way out.
  await expect(page.getByTestId("planned-strip").first()).toContainText(
    `up to ${USD} dollars`,
  );
});

test("the dot counts a new step of the same task as news again, and opening the project reads it", async ({
  page,
}) => {
  const s = await scene("newsdot", (w) => w.who.backer);
  await holder(page, s, "/you");
  await expect(page.getByTestId("news-row").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("you-badge")).toHaveCount(0);

  // The worker takes the task: money is set aside. The server reads it. The holder is on Home; the app is opened again.
  await takeOnChain(s.w, s.project, s.w.who.stranger, 1n);
  expect((await taskOnChain(s.project, 1n))?.state).toBe("taken");
  await s.server.republish();
  await page.clock.install({ time: (await chainNow()) * 1000 });
  await page.goto("/");
  await expect(page.getByTestId("you-badge")).toContainText("1", {
    timeout: 20_000,
  });
  // The news says what happened, and is new.
  await page.getByTestId("tab-link-you").click();
  const taken = page.getByTestId("news-row").first();
  await expect(taken).toContainText(`“${WHAT}” was taken.`, {
    timeout: 20_000,
  });
  await expect(taken).toContainText("set aside until ");
  await expect(taken).toHaveAttribute("data-unseen", "true");
  await expect(page.getByTestId("news-mark-read")).toHaveText("Mark 1 as read");
  // It was marked read as soon as it was drawn.
  await expect(page.getByTestId("you-badge")).toHaveCount(0);
  await page.getByTestId("news-mark-read").click();
  await expect(taken).toHaveAttribute("data-unseen", "false");
  await expect(page.getByTestId("news-mark-read")).toHaveCount(0);

  // The team sends the money back: another new step. On the project's own page the strips are the news, so opening it reads it.
  await sendBackOnChain(s.w, s.project, 1n);
  await s.server.republish();
  await page.clock.install({ time: (await chainNow()) * 1000 });
  await page.goto("/");
  await expect(page.getByTestId("you-badge")).toContainText("1", {
    timeout: 20_000,
  });
  await page.goto(pageOf(s.project.label));
  // The page has read the server's record once the Money tab shows what the project holds.
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("project-money")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("tab-link-home").click();
  await expect(page.getByTestId("you-badge")).toHaveCount(0);
  await page.getByTestId("tab-link-you").click();
  await expect(page.getByTestId("news-row").first()).toContainText(
    `“${WHAT}” ended and nothing was paid. The money went back to the project.`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("news-row").first()).toHaveAttribute(
    "data-unseen",
    "false",
  );
});

test("a holder who was away finds the planned task still there, with the right date, when the app's clock has moved on", async ({
  page,
}) => {
  const s = await scene("newsweek", (w) => w.who.helper);
  const notice = await noticeSecs(s.project);
  const planned = await taskOnChain(s.project, 1n);
  expect(planned?.state).toBe("announced");
  const noticeEnd = planned?.noticeEnd ?? 0;
  // The record is the one the server made when the plan was announced; only the app's clock moves, to a moment past the
  // age at which a record is called old and well inside the notice.
  const later = (await chainNow()) + 2_400;
  expect(later).toBeLessThan(noticeEnd);
  expect(notice).toBeGreaterThan(2_400);
  await openServer(page, s.relay, HOLDER_KEY);
  await installAnvilWallet(page, s.holder);
  await page.clock.install({ time: later * 1000 });
  await page.goto("/you");

  const row = page.getByTestId("news-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("the team plans to pay up to");
  await expect(row).toContainText("You can take your money out before then.");
  await expect(row).toContainText("(as of ");
  // The date is the network's, never the phone's: the day the notice ends.
  const date = new Date(noticeEnd * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  await expect(page.getByTestId("news-urgent")).toContainText(date);
  // The project's page reads the same, and says when the numbers are from.
  await page.goto(pageOf(s.project.label));
  const strip = page.getByTestId("planned-strip").first();
  await expect(strip).toContainText(`up to ${USD} dollars`, {
    timeout: 20_000,
  });
  await expect(strip).toContainText(date);
});

test("a person who holds nothing has no news, and still reads the strip on the project page", async ({
  page,
}) => {
  const s = await scene("newsnone", (w) => w.who.backer, 100n);
  await holder(page, s, "/you", s.w.who.member);
  await expect(page.getByTestId("news-none")).toHaveText(
    "No news about your projects.",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("news-row")).toHaveCount(0);
  await page.goto(pageOf(s.project.label));
  await expect(page.getByTestId("planned-strip").first()).toContainText(
    `up to ${USD} dollars`,
    { timeout: 20_000 },
  );
  // A stranger can read it, and has no Take out of someone else's money on it.
  await expect(
    page.getByRole("button", { name: /^Take out before / }),
  ).toHaveCount(0);
});

test("with no wallet there is no news section, and the strip is still on the project page", async ({
  page,
}) => {
  const s = await scene("newsnowallet", (w) => w.who.backer, 100n);
  await holder(page, s, "/you", null);
  await expect(page.getByTestId("you-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("news-section")).toHaveCount(0);
  await page.goto(pageOf(s.project.label));
  await expect(page.getByTestId("planned-strip").first()).toBeVisible({
    timeout: 20_000,
  });
});
