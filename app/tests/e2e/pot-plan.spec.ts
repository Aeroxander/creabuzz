import { type Page, expect, test } from "@playwright/test";
import { decodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  PAIR_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { walletOf } from "../anvil/pot-chain";
import { call, rpc } from "../anvil/rpc";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  backFor,
  checkIn,
  type LiveProject,
  type LiveWorld,
  launchProject,
  NO_CHAIN_WHY,
  passTime,
} from "./helpers/live-chain";
import {
  FOUNDER_KEY,
  FOUNDER_NOSTR,
  liveWorld,
  openServer,
  pageOf,
  READER_KEY,
  seedServer,
  syncClock,
} from "./helpers/live-browser";
import { MATE_KEY, seedTeamServer } from "./helpers/live-team";
import { installAnvilWallet, type WalletLog } from "./helpers/live-wallet";
import { event, now, profile, pubkeyOf, type Relay } from "./helpers/world";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The team's side of a planned task on a real local chain: plan the pay (so holders get notice first), pay part of it once the
 * worker has taken it, send the money back, withdraw a plan, and, with two people running the project, ask the other signer
 * and let them read each call before they confirm it. The server's record is read from the chain (`live-tasks.ts`) the way
 * the server's reader would write it; the page sees nothing else about the difference. Phone first (360 px), then a desktop
 * window, with the keyboard only where it matters.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const STRANGER = pubkeyOf(READER_KEY);
const DOLLAR = 1_000_000n;
const WHAT = "Translate the guide into Spanish";
const PHONE_360 = { width: 360, height: 780 };
const DESKTOP = { width: 1280, height: 800 };

/** A server that reads `project` with its task book, and the stranger's name on it. */
async function serverFor(w: LiveWorld, project: LiveProject, relay: Relay) {
  const server = await seedServer(relay, w, project, { tasks: true });
  relay.seed(profile(STRANGER, "Sam Stranger"));
  return server;
}

/** A page for `key`, with a wallet on `account`, on the project's Tasks tab. */
async function openTasks(
  page: Page,
  relay: Relay,
  project: LiveProject,
  key: string,
  account: string | null,
): Promise<WalletLog> {
  await openServer(page, relay, key);
  const wallet = await installAnvilWallet(page, account);
  await syncClock(page);
  await page.goto(pageOf(project.label));
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  return wallet;
}

const stepsOf = (relay: Relay, part: string) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.tags.some((t) => t[0] === "task-part" && t[1] === part),
  );
const tagOf = (e: { tags: string[][] } | undefined, name: string) =>
  e?.tags.find((t) => t[0] === name)?.[1];

/** A task the founder posted for `usd` dollars, taken by the stranger (paid at `payTo`), with work handed in. */
function seedHandedIn(
  relay: Relay,
  project: LiveProject,
  payTo: string,
  usd: number,
  handIn = true,
) {
  const at = now() - 3600;
  const task = event(
    47003,
    FOUNDER_NOSTR,
    { title: "Task", body: WHAT },
    [
      ["a", project.coordinate],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["task-what", WHAT],
      ["task-usd", String(usd)],
    ],
    at,
  );
  relay.seed(task);
  const step = (who: string, part: string, extra: string[][] = []) =>
    event(
      47003,
      who,
      { title: part, body: "the guide in Spanish" },
      [
        ["a", project.coordinate],
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", task.id],
        ["task", task.id],
        ...extra,
      ],
      at + 60,
    );
  relay.seed(step(STRANGER, "take", [["task-pay-to", payTo]]));
  if (handIn) relay.seed(step(STRANGER, "evidence"));
  return { task, step };
}

const txOf = (hash: string) =>
  rpc<{ from: string; to: string; input: string }>("eth_getTransactionByHash", [
    hash,
  ]);

/** What the chain says about task `serial` of the project. */
async function taskOnChain(project: LiveProject, serial: bigint) {
  const book = await reads.readBookOf(read, project.treasury);
  if (!book) throw new Error("no book");
  return reads.readTask(read, book, serial);
}

/** The team plans the task straight on the chain (what the press does), so a spec can start from a planned task. */
async function planOnChain(
  w: LiveWorld,
  project: LiveProject,
  taskId: string,
  usd: number,
  shareBps = 300,
) {
  await walletOf(w.who.founder).sendCalls(
    [
      pot.announceTaskCall({
        treasury: project.treasury,
        what: `0x${taskId}`,
        payee: w.who.stranger,
        maxDollars: BigInt(usd) * DOLLAR,
        shareBps,
      }),
    ],
    31337,
  );
}

/** Time passes until the notice is over, the team checks in again, and the stranger takes the task. */
async function takeOnChain(
  w: LiveWorld,
  project: LiveProject,
  serial: bigint,
  shareBps = 300,
) {
  const notice = await reads.readNoticeFor(read, project.treasury, shareBps);
  await passTime(notice.noticeSecs + 5);
  await checkIn(w, project);
  await walletOf(w.who.stranger).sendCalls(
    [
      pot.takeTaskCall({
        treasury: project.treasury,
        serial,
        minAmount: DOLLAR,
      }),
    ],
    31337,
  );
}

test("the team plans the pay of a task, holders see it, the worker takes it, the team pays part of it, and the record names that payment", async ({
  page,
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "planpay", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 450n);
  await checkIn(w, project);
  const relay = createMockRelay();
  const server = await serverFor(w, project, relay);
  const { task } = seedHandedIn(relay, project, w.who.stranger, 10);

  // The team: the pay is more than the allowance box can hold, so the card proposes a plan and says why.
  await page.setViewportSize(PHONE_360);
  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(page.getByTestId("door-sentence")).toContainText(
    "more than the allowance box can hold",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("door-sentence")).toHaveAttribute(
    "data-door",
    "plan",
  );
  await expectNoSidewaysScroll(page, "A task card with the plan door, 360 px");

  // Keyboard only: reach the press, open the sheet, read it, press.
  const door = page.getByTestId("door-plan");
  await expect(door).toHaveText("Plan the pay of 10 dollars");
  await door.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("plan-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("plan-pay-to")).toContainText(w.who.stranger, {
    ignoreCase: true,
    timeout: 20_000,
  });
  await expect(page.getByTestId("plan-max")).toContainText("10 dollars");
  await expect(page.getByTestId("plan-notice")).toContainText("Holders get");
  await expect(page.getByTestId("sheet-play-money")).toContainText(
    "play money",
  );
  await expectAccessible(page, "The Plan sheet, 360 px");
  await expectNoSidewaysScroll(page, "The Plan sheet, 360 px");
  // The names a screen reader reads: a dialog with a title, facts with labels, one press.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Plan this task" }),
  ).toHaveCount(1);
  const confirm = page.getByTestId("sheet-confirm");
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast").first()).toContainText("Planned.", {
    timeout: 30_000,
  });
  expect(founder.prompts).toBe(1);
  const planned = await taskOnChain(project, 1n);
  expect(planned?.state).toBe("announced");
  expect(planned?.what).toBe(`0x${task.id}`);
  expect(planned?.payee).toBe(w.who.stranger);
  expect(planned?.maxDollars).toBe(10n * DOLLAR);
  // What the sheet sent is exactly the call it described.
  const sentPlan = decodeCall(TREASURY_ABI, founder.sent[0]?.data ?? "");
  expect(sentPlan?.name).toBe("announceTask");
  expect(sentPlan?.args).toEqual([
    `0x${task.id}`,
    w.who.stranger,
    10n * DOLLAR,
    BigInt(planned?.shareBps ?? 0),
  ]);

  // The server reads the plan: the team's card says what the network says, with one door, and offers to withdraw it.
  await server.republish();
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("task-chain-state")).toContainText(
    "Planned. Can be taken from",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("door-choice")).toHaveCount(0);
  await expect(page.getByTestId("task-accept")).toHaveCount(0);
  await expect(page.getByTestId("withdraw-open")).toBeVisible();
  await expect(page.getByTestId("pay-open")).toHaveCount(0);

  // A stranger with no wallet reads the same headline, and cannot press anything on it.
  const reader = await (
    await browser.newContext({ viewport: PHONE_360 })
  ).newPage();
  await openTasks(reader, relay, project, READER_KEY, null);
  await expect(reader.getByTestId("task-chain-state")).toContainText(
    "Planned. Can be taken from",
    { timeout: 20_000 },
  );
  await expect(reader.getByTestId("withdraw-open")).toHaveCount(0);
  await expect(reader.getByTestId("pay-open")).toHaveCount(0);
  await expect(reader.getByTestId("send-back-open")).toHaveCount(0);

  // The notice is over, the team checked in again, and the worker takes the task with their own wallet.
  await takeOnChain(w, project, 1n, planned?.shareBps);
  const taken = await taskOnChain(project, 1n);
  expect(taken?.state).toBe("taken");
  expect(taken?.takenBy).toBe(w.who.stranger);
  await server.republish();
  // A desktop window, and a fresh page for the team (the chain's clock moved, and so did the page's).
  const desk = await (
    await browser.newContext({ viewport: DESKTOP })
  ).newPage();
  const founder2 = await openTasks(
    desk,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(desk.getByTestId("task-chain-state")).toContainText(
    "Taken, due",
    {
      timeout: 20_000,
    },
  );
  // Taken: nothing to withdraw; paying and sending back are the two ways on.
  await expect(desk.getByTestId("withdraw-open")).toHaveCount(0);
  await expect(desk.getByTestId("pay-open")).toHaveText("Pay for the work");
  await expect(desk.getByTestId("send-back-open")).toHaveText(
    "Send the money back",
  );

  // Pay part of it.
  const dollarsBefore = await reads.balanceOf(
    read,
    project.dollar,
    w.who.stranger,
  );
  await desk.getByTestId("pay-open").click();
  await expect(desk.getByTestId("accept-pay-to")).toContainText(
    w.who.stranger,
    {
      ignoreCase: true,
      timeout: 20_000,
    },
  );
  await expectNoSidewaysScroll(desk, "The pay sheet, desktop");
  await desk.getByTestId("accept-part").check();
  await desk.getByTestId("accept-amount").fill("4");
  await expect(desk.getByTestId("sheet-confirm")).toHaveText("Pay 4 dollars");
  await expect(desk.getByTestId("accept-left")).toContainText("go back");
  await expectAccessible(desk, "The pay sheet, desktop");
  await desk.getByTestId("sheet-confirm").click();
  await expect(desk.getByTestId("toast").first()).toContainText(
    "Paid 4 dollars to",
    { timeout: 30_000 },
  );
  expect(founder2.prompts).toBeGreaterThanOrEqual(1);
  const paid = await taskOnChain(project, 1n);
  expect(paid?.state).toBe("paid");
  expect(paid?.setAside).toBe(taken?.setAside);
  expect(paid?.returned).toBe((taken?.setAside ?? 0n) - 4n * DOLLAR);
  expect(
    (await reads.balanceOf(read, project.dollar, w.who.stranger)) -
      dollarsBefore,
  ).toBe(4n * DOLLAR);
  // The call: acceptTask for that task and that amount, with no recipient argument.
  const lastSent = founder2.sent.at(-1);
  const sentPay = decodeCall(TREASURY_ABI, lastSent?.data ?? "");
  expect(sentPay?.name).toBe("acceptTask");
  expect(sentPay?.args).toEqual([1n, 4n * DOLLAR]);

  // The team's record names the transaction the network gives for the task's number: the one that paid.
  await expect
    .poll(() => stepsOf(relay, "confirm").length, { timeout: 20_000 })
    .toBe(1);
  const [confirmStep] = stepsOf(relay, "confirm");
  expect(confirmStep?.pubkey).toBe(FOUNDER_NOSTR);
  const paidTx = tagOf(confirmStep, "task-paid") ?? "";
  const landed = await txOf(paidTx);
  expect(landed.input).toBe(lastSent?.data);
  expect(landed.from.toLowerCase()).toBe(w.who.founder);
  expect(landed.to.toLowerCase()).toBe(project.treasury);

  // Everyone reads the part payment as a part payment, never as paid in full.
  await server.republish();
  await desk.reload();
  await desk.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(desk.getByTestId("task-chain-state")).toHaveText(
    "Paid 4 dollars.",
    {
      timeout: 20_000,
    },
  );
  await expect(desk.getByTestId("task-chain-detail")).toContainText(
    "Paid 4 dollars of the",
  );
  await expect(desk.getByTestId("task-paid")).toHaveCount(0);
  await expect(desk.getByTestId("pay-open")).toHaveCount(0);
  await expect(desk.getByTestId("save-paid")).toHaveCount(0);
  await expectAccessible(desk, "A paid task, desktop");
});

test("the team sends a taken task's money back: nobody is paid, and everyone reads it as sent back", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "planback", FOUNDER_NOSTR);
  await backFor(w, project, w.who.member, 450n);
  await checkIn(w, project);
  const relay = createMockRelay();
  const server = await serverFor(w, project, relay);
  const { task } = seedHandedIn(relay, project, w.who.stranger, 10);
  await planOnChain(w, project, task.id, 10);
  await takeOnChain(w, project, 1n);
  await server.republish();

  await page.setViewportSize(PHONE_360);
  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(page.getByTestId("task-chain-state")).toContainText(
    "Taken, due",
    {
      timeout: 20_000,
    },
  );
  const dollarsBefore = await reads.balanceOf(
    read,
    project.dollar,
    w.who.stranger,
  );
  await page.getByTestId("send-back-open").click();
  await expect(page.getByTestId("send-back-words")).toContainText(
    "Nobody is paid. All",
    { timeout: 20_000 },
  );
  await expectAccessible(page, "The Send back sheet, 360 px");
  await expectNoSidewaysScroll(page, "The Send back sheet, 360 px");
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("toast").first()).toContainText(
    "Sent back. The money is in the project again.",
    { timeout: 30_000 },
  );
  expect((await taskOnChain(project, 1n))?.state).toBe("rejected");
  expect(await reads.balanceOf(read, project.dollar, w.who.stranger)).toBe(
    dollarsBefore,
  );
  const sentBack = decodeCall(TREASURY_ABI, founder.sent.at(-1)?.data ?? "");
  expect(sentBack?.name).toBe("rejectTask");
  expect(sentBack?.args).toEqual([1n]);

  await server.republish();
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("task-plan-ended")).toContainText(
    "was sent back. Nothing was paid",
    { timeout: 20_000 },
  );
  // The plan ended unpaid: nothing is offered on the network any more.
  await expect(page.getByTestId("send-back-open")).toHaveCount(0);
  await expect(page.getByTestId("pay-open")).toHaveCount(0);
});

test("the team withdraws a plan nobody has taken, and may then stop the task on its own list", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "planout", FOUNDER_NOSTR);
  await backFor(w, project, w.who.helper, 450n);
  await checkIn(w, project);
  const relay = createMockRelay();
  const server = await serverFor(w, project, relay);
  const { task } = seedHandedIn(relay, project, w.who.stranger, 10, false);
  await planOnChain(w, project, task.id, 10);
  await server.republish();

  await page.setViewportSize(PHONE_360);
  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(page.getByTestId("task-chain-state")).toContainText("Planned.", {
    timeout: 20_000,
  });
  // Keyboard only.
  const open = page.getByTestId("withdraw-open");
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("withdraw-words")).toContainText(
    "Nobody has taken it, so no money moves.",
    { timeout: 20_000 },
  );
  await expectAccessible(page, "The Withdraw sheet, 360 px");
  await expectNoSidewaysScroll(page, "The Withdraw sheet, 360 px");
  await page.getByTestId("sheet-confirm").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast").first()).toContainText("Withdrawn.", {
    timeout: 30_000,
  });
  expect((await taskOnChain(project, 1n))?.state).toBe("cancelled");
  const sent = decodeCall(TREASURY_ABI, founder.sent.at(-1)?.data ?? "");
  expect(sent?.name).toBe("cancelTask");
  expect(sent?.args).toEqual([1n]);

  // The network is first; stopping the task on the team's list is offered, not forced.
  await server.republish();
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("task-plan-ended")).toContainText(
    "was withdrawn",
    { timeout: 20_000 },
  );
  expect(stepsOf(relay, "cancel")).toHaveLength(0);
  await expect(page.getByTestId("stop-task")).toBeVisible();
  await page.getByTestId("stop-task-press").click();
  await expect
    .poll(() => stepsOf(relay, "cancel").length, { timeout: 20_000 })
    .toBe(1);
  expect(tagOf(stepsOf(relay, "cancel")[0], "task")).toBe(task.id);
});

test("a project run by two: one signer asks to plan, the other reads the plan in plain words and confirms, and it is planned", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "planpair", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 450n);
  const pairAddress = await state.pairAddressOf(
    read,
    w.chain.launcher,
    project.key,
    w.who.founder,
    w.who.backer,
  );
  await walletOf(w.who.founder).sendCalls(
    [
      pot.handOverCall({
        treasury: project.treasury,
        next: pairAddress,
        founderLeaves: false,
      }),
    ],
    31337,
  );
  await walletOf(w.who.backer).sendCalls(
    [pot.makePairCall(w.chain.launcher, project.key, w.who.founder)],
    31337,
  );
  await walletOf(w.who.founder).sendCalls(
    [pot.pairCheckInCall(pairAddress, `0x${"5d".repeat(32)}`)],
    31337,
  );
  const relay = createMockRelay();
  relay.seed(profile(STRANGER, "Sam Stranger"));
  await seedTeamServer(relay, w, project, w.who.backer, { tasks: true });
  const { task } = seedHandedIn(relay, project, w.who.stranger, 10);

  await page.setViewportSize(PHONE_360);
  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await page.getByTestId("door-plan").click({ timeout: 20_000 });
  await expect(page.getByTestId("sheet-confirm")).toHaveText(
    "Ask the other signer",
    { timeout: 20_000 },
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("toast").first()).toContainText(
    "Asked. It is planned when the other signer confirms.",
    { timeout: 30_000 },
  );
  expect(founder.prompts).toBe(1);
  expect(decodeCall(PAIR_ABI, founder.sent[0]?.data ?? "")?.name).toBe(
    "propose",
  );
  // Nothing is planned yet.
  expect(await taskOnChain(project, 1n)).toBeNull();

  // The other signer reads what the call does, in words, with the task's own words under it, and confirms.
  const matePage = await page.context().newPage();
  await matePage.setViewportSize(PHONE_360);
  await openServer(matePage, relay, MATE_KEY);
  const mate = await installAnvilWallet(matePage, w.who.backer);
  await syncClock(matePage);
  await matePage.goto(pageOf(project.label));
  await matePage.getByTestId("tab-money").click({ timeout: 20_000 });
  const terms = matePage.getByTestId("pair-terms");
  await expect(terms).toContainText("Plan a task: pay up to 10 dollars to", {
    timeout: 30_000,
  });
  await expect(terms).toContainText(w.who.stranger, { ignoreCase: true });
  await expect(terms).toContainText("Holders get");
  await expect(matePage.getByTestId("pair-terms-more").first()).toHaveText(
    "The date counts from when you confirm.",
  );
  await expect(matePage.getByTestId("pair-terms-more").nth(1)).toContainText(
    WHAT,
  );
  await expectAccessible(matePage, "The waiting plan, 360 px");
  await expectNoSidewaysScroll(matePage, "The waiting plan, 360 px");
  await matePage.getByTestId("pair-review").click();
  await expect(matePage.getByTestId("pair-sheet-terms")).toContainText(
    "Plan a task: pay up to 10 dollars to",
  );
  await matePage.getByTestId("sheet-confirm").click();
  await expect(matePage.getByTestId("sheet-confirm")).toBeHidden({
    timeout: 30_000,
  });
  expect(mate.prompts).toBe(1);
  const planned = await taskOnChain(project, 1n);
  expect(planned?.state).toBe("announced");
  expect(planned?.what).toBe(`0x${task.id}`);
  expect(planned?.maxDollars).toBe(10n * DOLLAR);
});

test("a task that names its helper: until they say yes and name their wallet the team cannot plan the pay; once they have, it can", async ({
  page,
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "planname", FOUNDER_NOSTR);
  await backFor(w, project, w.who.helper, 450n);
  await checkIn(w, project);
  const relay = createMockRelay();
  await serverFor(w, project, relay);
  // The team made a task for one person (made by the command line or an agent: the app's own "Post a task" is open to anyone).
  const at = now() - 3600;
  const task = event(
    47003,
    FOUNDER_NOSTR,
    { title: "Task", body: WHAT },
    [
      ["a", project.coordinate],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["task-what", WHAT],
      ["task-usd", "10"],
      ["task-helper", STRANGER],
    ],
    at,
  );
  relay.seed(task);

  // The team: the helper has named no wallet, so nothing can be planned, and the card says why.
  await page.setViewportSize(PHONE_360);
  await openTasks(page, relay, project, FOUNDER_KEY, w.who.founder);
  await expect(page.getByTestId("door-waiting")).toContainText(
    "has not named an account to be paid at",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("door-plan")).toHaveCount(0);

  // The helper: "This task is for you", one press names the wallet they connected.
  const helper = await (
    await browser.newContext({ viewport: PHONE_360 })
  ).newPage();
  const wallet = await openTasks(
    helper,
    relay,
    project,
    READER_KEY,
    w.who.stranger,
  );
  await expect(helper.getByTestId("agree-words")).toContainText(
    "This task is for you.",
    { timeout: 20_000 },
  );
  await expectAccessible(helper, "A task made for the helper, 360 px");
  await expectNoSidewaysScroll(helper, "A task made for the helper, 360 px");
  await helper.getByTestId("agree-press").focus();
  await helper.keyboard.press("Enter");
  await expect
    .poll(() => stepsOf(relay, "accept").length, { timeout: 20_000 })
    .toBe(1);
  const [yes] = stepsOf(relay, "accept");
  expect(yes?.pubkey).toBe(STRANGER);
  expect(tagOf(yes, "task-pay-to")?.toLowerCase()).toBe(w.who.stranger);
  expect(tagOf(yes, "task")).toBe(task.id);
  // The wallet was only asked to share its account: nothing was signed for the chain.
  expect(wallet.sent).toEqual([]);
  await expect(helper.getByTestId("agree")).toHaveCount(0, { timeout: 20_000 });

  // The team now can plan the pay, to exactly that wallet.
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("door-plan")).toHaveText(
    "Plan the pay of 10 dollars",
    {
      timeout: 20_000,
    },
  );
  await page.getByTestId("door-plan").click();
  await expect(page.getByTestId("plan-pay-to")).toContainText(w.who.stranger, {
    ignoreCase: true,
    timeout: 20_000,
  });
});
