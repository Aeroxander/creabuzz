import { expect, type Page, test } from "@playwright/test";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call } from "../anvil/rpc";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  backFor,
  chainNow,
  checkIn,
  launchProject,
  NO_CHAIN_WHY,
  passTime,
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
  planOnChain,
  seedTaskRecord,
  sendBackOnChain,
  takeOnChain,
  taskOnChain,
  WHAT,
  WORKER,
} from "./helpers/live-plans";
import { profile, type Relay } from "./helpers/world";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * Money a leaver is owed from a task, on a real local chain: a holder takes out while money is set aside for a task, holds a
 * claim on it, reads that it is still running, then reads what it pays once the team sends the money back, claims it with one
 * wallet prompt and is paid exactly what the network said. A browser that has none of the person's history finds the claim
 * from the server's rows alone and the look back says how far it got. A task that ran out and that nobody settled is claimed in
 * full, and the claim settles it. Phone first (390 px, then 360 px).
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const LEAVER_KEY = "a5".repeat(32);
const USD = 10;
const PHONE_360 = { width: 360, height: 780 };

interface Scene {
  w: LiveWorld;
  project: LiveProject;
  relay: Relay;
  server: Awaited<ReturnType<typeof seedServer>>;
  /** The account that will take out while money is set aside. */
  leaver: string;
  book: string;
}

/**
 * A project two accounts hold (the leaver and one who stays), a task planned for the stranger and taken by them: money is set
 * aside, and the server has read it.
 */
async function scene(
  label: string,
  who: { leaver: (w: LiveWorld) => string; stayer: (w: LiveWorld) => string },
): Promise<Scene> {
  const w = world.get();
  const project = await launchProject(w, label, FOUNDER_NOSTR);
  const leaver = who.leaver(w);
  await backFor(w, project, leaver, 300n);
  await backFor(w, project, who.stayer(w), 300n);
  await checkIn(w, project);
  const relay = createMockRelay();
  const server = await seedServer(relay, w, project, {
    tasks: true,
    holders: [leaver, who.stayer(w)],
  });
  relay.seed(profile(WORKER, "Sam Stranger"));
  const taskId = seedTaskRecord(relay, project, w.who.stranger, USD);
  await planOnChain(w, project, taskId, w.who.stranger, USD);
  await takeOnChain(w, project, w.who.stranger, 1n);
  expect((await taskOnChain(project, 1n))?.state).toBe("taken");
  await server.republish();
  const book = await reads.readBookOf(read, project.treasury);
  if (!book) throw new Error("the project has no task book");
  return { w, project, relay, server, leaver, book };
}

/** A phone for the leaver on the project's Money tab, the wallet on their account. */
async function openMoney(page: Page, s: Scene, key = LEAVER_KEY) {
  await openServer(page, s.relay, key);
  const wallet = await installAnvilWallet(page, s.leaver);
  await syncClock(page);
  await page.goto(pageOf(s.project.label));
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("project-money")).toBeVisible({
    timeout: 20_000,
  });
  return wallet;
}

/** Takes out all of the leaver's Shares through the sheet, as a person does; returns the cash that landed. */
async function takeOutAll(page: Page, s: Scene): Promise<bigint> {
  const before = await reads.balanceOf(read, s.project.dollar, s.leaver);
  await page.getByTestId("holding-take-out").click();
  const sheet = page.getByTestId("takeout-sheet");
  await expect(sheet).toBeVisible();
  // The Take out sheet says part of the project's money is set aside for a task, and the way to claim what is owed.
  await expect(page.getByTestId("takeout-note")).toContainText(
    "is set aside for a task",
  );
  await expect(page.getByTestId("takeout-where-to-claim")).toBeVisible();
  await page.getByTestId("sheet-confirm").click();
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  const cash =
    (await reads.balanceOf(read, s.project.dollar, s.leaver)) - before;
  expect(cash).toBeGreaterThan(0n);
  expect(await reads.balanceOf(read, s.project.shares, s.leaver)).toBe(0n);
  return cash;
}

test("a leaver takes out while money is set aside, reads that the claim waits on the task, and claims it once the money is sent back", async ({
  page,
  browser,
}) => {
  const s = await scene("noteclaim", {
    leaver: (w) => w.who.second,
    stayer: (w) => w.who.backer,
  });
  const wallet = await openMoney(page, s);
  await expect(page.getByTestId("holding-shares")).toBeVisible({
    timeout: 20_000,
  });
  await takeOutAll(page, s);
  const face = await reads.readNoteOf(read, s.book, 1n, s.leaver);
  expect(face).toBeGreaterThan(0n);

  // The task still runs: the section says so and what could be claimed, and offers no press yet.
  await page.reload();
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  const section = page.getByTestId("notes-section");
  const row = section.getByTestId("notes-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(`“${WHAT}”: you took out while `);
  await expect(row).toContainText("The task is still running.");
  await expect(row).toContainText("You will be able to claim up to ");
  await expect(section.getByTestId("notes-claim")).toHaveCount(0);
  await expect(section.getByTestId("notes-play-money")).toContainText(
    "play money",
  );

  // The team sends the money back: nothing was paid, so the whole claim is payable.
  await sendBackOnChain(s.w, s.project, 1n);
  await s.server.republish();
  const owed = await reads.readClaimable(read, s.book, 1n, s.leaver);
  expect(owed).toBeGreaterThan(0n);
  await page.reload();
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  const ended = page
    .getByTestId("notes-section")
    .getByTestId("notes-row")
    .first();
  await expect(ended).toContainText("The task is ended.", { timeout: 20_000 });
  await expect(ended).toContainText("You can claim ");
  const press = page.getByTestId("notes-claim");
  await expect(press).toHaveText(/^Claim [\d,.]+ dollars?$/);
  await expectAccessible(page, "The money you can claim, 390 px");
  await page.setViewportSize(PHONE_360);
  await expectNoSidewaysScroll(page, "The money you can claim, 360 px");

  // A browser with none of the person's history finds the same claim from the server's rows alone, and a look back says how
  // far it got (here: to the start of the project's tasks, where it found it).
  const fresh = await (
    await browser.newContext({ viewport: PHONE_360 })
  ).newPage();
  await openMoney(fresh, s, "a6".repeat(32));
  await expect(
    fresh.getByTestId("notes-section").getByTestId("notes-claim"),
  ).toBeVisible({ timeout: 20_000 });
  await fresh.getByTestId("notes-look").click();
  await expect(fresh.getByTestId("notes-look-words")).toContainText(
    "start of this project's tasks",
    { timeout: 30_000 },
  );

  // The claim: one press, one prompt, and what lands is what the network said.
  const cashBefore = await reads.balanceOf(read, s.project.dollar, s.leaver);
  const promptsBefore = wallet.prompts;
  await press.click();
  const sheet = page.getByTestId("claim-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("claim-words")).toContainText(
    "The money goes to your account.",
  );
  await expect(page.getByTestId("claim-owed")).toContainText("dollars");
  await expect(page.getByTestId("sheet-play-money")).toContainText(
    "play money",
  );
  await expectAccessible(page, "The Claim sheet, 360 px");
  await expectNoSidewaysScroll(page, "The Claim sheet, 360 px");
  await page.getByTestId("sheet-confirm").click();
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  expect(wallet.prompts - promptsBefore).toBe(1);
  expect(
    (await reads.balanceOf(read, s.project.dollar, s.leaver)) - cashBefore,
  ).toBe(owed);
  expect(await reads.readNoteOf(read, s.book, 1n, s.leaver)).toBe(0n);

  // Nothing is left to claim, and the section says so (it was read from the network, not guessed).
  await page.reload();
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("notes-none")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("notes-claim")).toHaveCount(0);
});

test("a task that ran out and that nobody settled is claimed in full, and the claim settles it", async ({
  page,
}) => {
  const s = await scene("noteranout", {
    leaver: (w) => w.who.member,
    stayer: (w) => w.who.backer,
  });
  const wallet = await openMoney(page, s);
  await expect(page.getByTestId("holding-shares")).toBeVisible({
    timeout: 20_000,
  });
  await takeOutAll(page, s);
  const face = await reads.readNoteOf(read, s.book, 1n, s.leaver);
  expect(face).toBeGreaterThan(0n);

  // The deadline passes and nobody settles: the network still has the task as taken, and says nothing is claimable yet.
  const dueSecs = (await reads.readNoticeFor(read, s.project.treasury, 300))
    .dueSecs;
  await passTime(dueSecs + 60);
  expect((await taskOnChain(s.project, 1n))?.state).toBe("taken");
  expect(await reads.readClaimable(read, s.book, 1n, s.leaver)).toBe(0n);
  await s.server.republish();
  await page.clock.install({ time: (await chainNow()) * 1000 });
  await page.goto(pageOf(s.project.label));
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  const row = page
    .getByTestId("notes-section")
    .getByTestId("notes-row")
    .first();
  await expect(row).toContainText("This task ran out.", { timeout: 20_000 });
  await expect(row).toContainText("claiming returns the money first");
  const before = await reads.balanceOf(read, s.project.dollar, s.leaver);
  const prompts = wallet.prompts;
  await page.getByTestId("notes-claim").click();
  await expect(page.getByTestId("claim-words")).toContainText(
    "Claiming returns it first",
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("claim-sheet")).toBeHidden({ timeout: 30_000 });
  expect(wallet.prompts - prompts).toBe(1);
  // The whole claim was paid, and the task was settled by the same step.
  expect(
    (await reads.balanceOf(read, s.project.dollar, s.leaver)) - before,
  ).toBe(face);
  expect((await taskOnChain(s.project, 1n))?.state).toBe("returned");
  expect(await reads.readNoteOf(read, s.book, 1n, s.leaver)).toBe(0n);
});

test("Take out works with money set aside for a task while the server's record cannot be read at all", async ({
  page,
}) => {
  const s = await scene("notestay", {
    leaver: (w) => w.who.second,
    stayer: (w) => w.who.helper,
  });
  // The server's record cannot be read at all: Take out still works, as it does with a record that is old.
  await openServer(page, s.relay, LEAVER_KEY);
  const wallet = await installAnvilWallet(page, s.leaver);
  await syncClock(page);
  s.relay.setClosingSockets((filter) =>
    Boolean((filter?.kinds as number[] | undefined)?.includes(39009)),
  );
  await page.goto(pageOf(s.project.label));
  await page.getByRole("tab", { name: "Money" }).click({ timeout: 20_000 });
  await expect(page.getByTestId("holding-take-out")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("holding-take-out").click();
  await expect(page.getByTestId("takeout-sheet")).toBeVisible();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(wallet.prompts).toBe(1);
  expect(await reads.balanceOf(read, s.project.shares, s.leaver)).toBe(0n);
});
