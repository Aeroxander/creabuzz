import { type Browser, type Page, expect, test } from "@playwright/test";
import {
  decodeCall,
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  PAIR_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import {
  revokeAgentCall,
  setAgentCall,
} from "../../src/features/tasks/task-calls";
import { call, rpc } from "../anvil/rpc";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
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
import {
  DAY,
  event,
  install,
  now,
  profile,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/world";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * Tasks in the default build on a real local chain, at 390x844. The team posts a task (what, what it pays), a stranger takes
 * it and hands the work in, and the founder accepts and pays from the allowance box in one press. When the pay cannot go in
 * that press (the box is short) the work is accepted now, every reader sees "accepted, pay owed", and the task offers "Pay from
 * the box" once the box holds enough: the payment is written on the same task. With a Pair running the project the signer asks,
 * the other signer reads which task the draw pays for and confirms, and the payment is then found and saved on the task. The
 * runner sets an agent's daily limits and switches it off.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const STRANGER = pubkeyOf(READER_KEY);
const AGENT_KEY = "a3".repeat(32);
const AGENT = pubkeyOf(AGENT_KEY);
const DOLLAR = 1_000_000n;
const WHAT = "Translate the guide into Spanish";

/** A server that reads `project`, with the stranger's name on it. */
async function serverFor(w: LiveWorld, project: LiveProject, relay: Relay) {
  const server = await seedServer(relay, w, project);
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

async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  return context.newPage();
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
function seedHandedIn(relay: Relay, project: LiveProject, payTo: string) {
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
      ["task-usd", "3"],
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
  const piece = step(STRANGER, "evidence");
  relay.seed(piece);
  return { task, piece, step };
}

/** The transaction as the chain holds it. */
const txOf = (hash: string) =>
  rpc<{ from: string; to: string; input: string }>("eth_getTransactionByHash", [
    hash,
  ]);

test(`Post a task: ${PLAN_V2_BUDGETS.postTask.presses} presses and ${PLAN_V2_BUDGETS.postTask.fields} fields, a stranger takes it and hands in, and the founder accepts and pays from the box in ${PLAN_V2_BUDGETS.acceptAndPay.presses} press`, async ({
  page,
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "taskpaid", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 450n);
  // About eight days of the allowance (a day is four minutes on this chain) fill the box with more than the task pays.
  await passTime(2000);
  await checkIn(w, project);
  const relay = createMockRelay();
  await serverFor(w, project, relay);

  // The founder posts.
  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(page.getByTestId("tasks-none")).toBeVisible();
  const post = new PressCounter();
  await post.press(page.getByTestId("task-new"), "Post a task");
  await expect(page.getByTestId("post-task-sheet")).toBeVisible();
  await expectAccessible(page, "Post a task");
  await post.type(page.getByTestId("task-what"), WHAT, "What needs doing");
  await post.type(page.getByTestId("task-dollars"), "3", "It pays");
  await post.read(page, "the sheet");
  await post.press(page.getByTestId("task-post"), "Post");
  const card = page.getByTestId("task-card");
  await expect(card).toContainText("Pays 3 dollars on accept", {
    timeout: 20_000,
  });
  await expect(card.getByTestId("task-state")).toHaveText("Open to anyone");
  console.log(post.summary("Post a task"));
  expect(post.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.postTask.presses);
  expect(post.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.postTask.fields);
  expect(tagOf(stepsOf(relay, "task")[0], "task-usd")).toBe("3");
  // The team does not take its own open task.
  await expect(card.getByTestId("task-take")).toHaveCount(0);

  // A stranger takes it with their wallet, and hands the work in.
  const stranger = await phone(browser);
  await openTasks(stranger, relay, project, READER_KEY, w.who.stranger);
  await stranger.getByTestId("task-take").click({ timeout: 20_000 });
  await expect(stranger.getByTestId("task-worker")).toContainText("You", {
    timeout: 20_000,
  });
  expect(tagOf(stepsOf(relay, "take")[0], "task-pay-to")?.toLowerCase()).toBe(
    w.who.stranger,
  );
  await stranger.getByTestId("task-hand-in").click();
  await stranger
    .getByTestId("task-note")
    .fill("The guide in Spanish: https://example.org/es");
  await stranger.getByTestId("task-hand-in-send").click();
  await expect(stranger.getByTestId("task-state")).toHaveText(
    "Work handed in",
    { timeout: 20_000 },
  );
  // Nothing was paid before a person accepted the work, and the stranger is offered no press to accept.
  await expect(stranger.getByTestId("task-accept")).toHaveCount(0);
  expect(await reads.balanceOf(read, project.dollar, w.who.stranger)).toBe(0n);

  // The founder accepts and pays from the box: one press, one wallet prompt.
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  const accept = page.getByTestId("task-accept");
  await expect(accept).toHaveText("Accept and pay 3 dollars", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-play-money")).toContainText("play money");
  await expectAccessible(page, "Tasks with work handed in");
  await expectNoSidewaysScroll(page, "Tasks");
  const pay = new PressCounter();
  const before = await reads.balanceOf(read, project.dollar, w.who.stranger);
  await pay.press(accept, "Accept and pay 3 dollars");
  await expect(page.getByTestId("toast")).toContainText(
    "Accepted and paid 3 dollars.",
    { timeout: 30_000 },
  );
  expect(founder.prompts).toBe(1);
  expect(
    (await reads.balanceOf(read, project.dollar, w.who.stranger)) - before,
  ).toBe(3n * DOLLAR);
  // One draw from the Treasury, of exactly the pay, to the wallet the stranger named.
  const [sent] = founder.sent;
  expect(sent?.to.toLowerCase()).toBe(project.treasury);
  expect(decodeCall(TREASURY_ABI, sent?.data ?? "")?.args).toEqual([
    w.who.stranger,
    3n * DOLLAR,
  ]);
  // The acceptance names that very transaction.
  const [confirm] = stepsOf(relay, "confirm");
  expect(confirm?.pubkey).toBe(FOUNDER_NOSTR);
  const paidTx = tagOf(confirm, "task-paid") ?? "";
  const landed = await txOf(paidTx);
  expect(landed.input).toBe(sent?.data);
  expect(landed.from.toLowerCase()).toBe(w.who.founder);
  await expect(page.getByTestId("task-state")).toHaveText("Accepted", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-paid")).toHaveText("Paid 3 dollars.");
  await expect(page.getByTestId("task-pay-owed")).toHaveCount(0);
  // The stranger reads it as paid too.
  await stranger.reload();
  await stranger.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(stranger.getByTestId("task-paid")).toHaveText(
    "Paid 3 dollars.",
    {
      timeout: 20_000,
    },
  );
  console.log(pay.summary("Accept and pay"));
  expect(pay.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.acceptAndPay.presses);
  expect(pay.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.acceptAndPay.fields);
});

test("with the server reading the task book, a task nobody planned keeps the box flow: the card says why the box is the door, offers the plan as a second way in, and Accept and pay still pays in one press", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "taskdoor", FOUNDER_NOSTR);
  await backFor(w, project, w.who.helper, 450n);
  await passTime(2000);
  await checkIn(w, project);
  const relay = createMockRelay();
  // The server follows the project's task book now: its record carries the (empty) queue.
  await seedServer(relay, w, project, { tasks: true });
  relay.seed(profile(STRANGER, "Sam Stranger"));
  seedHandedIn(relay, project, w.who.stranger);

  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  // No plan on the network for this task: the box is the door, and the sentence beside the press says why.
  await expect(page.getByTestId("door-sentence")).toContainText(
    "enough to pay this on any day, with no notice",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("door-sentence")).toHaveAttribute(
    "data-door",
    "box",
  );
  // The plan stays one press away, for a team that prefers to give notice.
  await expect(page.getByTestId("door-plan-also")).toHaveText(
    "Plan it instead, so holders get notice first.",
  );
  const accept = page.getByTestId("task-accept");
  await expect(accept).toHaveText("Accept and pay 3 dollars");
  const before = await reads.balanceOf(read, project.dollar, w.who.stranger);
  await accept.click();
  await expect(page.getByTestId("toast")).toContainText(
    "Accepted and paid 3 dollars.",
    { timeout: 30_000 },
  );
  expect(founder.prompts).toBe(1);
  expect(
    (await reads.balanceOf(read, project.dollar, w.who.stranger)) - before,
  ).toBe(3n * DOLLAR);
  expect(stepsOf(relay, "confirm")).toHaveLength(1);
});

test("with the box short the work is accepted now and shown as 'accepted, pay owed' to everyone, never as paid; once the box holds enough the task is paid from the box and the payment is written on the same task", async ({
  page,
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "tasklater", FOUNDER_NOSTR);
  await backFor(w, project, w.who.member, 450n);
  const relay = createMockRelay();
  const server = await serverFor(w, project, relay);
  const { task, piece } = seedHandedIn(relay, project, w.who.stranger);

  // Founder: the box holds nothing yet, so the ordinary press is not offered; accepting without paying is the plain second choice.
  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(page.getByTestId("task-accept-problem")).toContainText(
    "The allowance box holds",
    { timeout: 20_000 },
  );
  const button = page.getByTestId("task-accept");
  await expect(button).toHaveText("Accept now, pay 3 dollars later");
  await button.click();
  await expect(page.getByTestId("task-pay-later")).toContainText(
    "It will show as accepted, pay owed",
  );
  await button.click();
  await expect(page.getByTestId("toast")).toContainText(
    "The pay is still owed: 3 dollars.",
    { timeout: 20_000 },
  );
  expect(founder.prompts).toBe(0);
  const [accepted] = stepsOf(relay, "confirm");
  expect(accepted?.pubkey).toBe(FOUNDER_NOSTR);
  expect(tagOf(accepted, "task-paid")).toBeUndefined();
  expect(tagOf(accepted, "task-evidence")).toBe(piece.id);
  await expect(page.getByTestId("task-state")).toHaveText("Accepted", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-pay-owed")).toHaveText(
    "Accepted, pay owed: 3 dollars.",
  );
  await expect(page.getByTestId("task-paid")).toHaveCount(0);
  await expect(page.getByTestId("task-pays")).toHaveCount(0);
  // The pay waits for the box, and says how much it holds.
  await expect(page.getByTestId("task-pay-box-short")).toContainText(
    "Pay it when the box holds enough.",
  );
  await expect(page.getByTestId("task-pay")).toHaveCount(0);
  await expectAccessible(page, "Tasks, accepted with the pay owed");
  await expectNoSidewaysScroll(page, "Tasks, pay owed");

  // The stranger and a reader read the same: owed, not paid, and nothing to press.
  const stranger = await phone(browser);
  await openTasks(stranger, relay, project, READER_KEY, w.who.stranger);
  await expect(stranger.getByTestId("task-pay-owed")).toHaveText(
    "Accepted, pay owed: 3 dollars.",
    { timeout: 20_000 },
  );
  await expect(stranger.getByTestId("task-paid")).toHaveCount(0);
  await expect(stranger.getByTestId("task-pay-section")).toHaveCount(0);

  // The box fills: more backing, time, and a check-in that settles it; the server reads the chain again.
  await backFor(w, project, w.who.member, 450n);
  await passTime(2000);
  await checkIn(w, project);
  await server.republish();
  await syncClock(page);
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  const payButton = page.getByTestId("task-pay");
  await expect(payButton).toHaveText("Pay from the box", { timeout: 30_000 });
  await expect(page.getByTestId("task-pay-terms")).toContainText(
    w.who.stranger,
  );
  const pay = new PressCounter();
  const owed = await reads.balanceOf(read, project.dollar, w.who.stranger);
  await pay.press(payButton, "Pay from the box");
  await expect(page.getByTestId("toast")).toContainText("Paid 3 dollars.", {
    timeout: 30_000,
  });
  // The only prompt of the whole page was this payment's.
  expect(founder.prompts).toBe(1);
  expect(
    (await reads.balanceOf(read, project.dollar, w.who.stranger)) - owed,
  ).toBe(3n * DOLLAR);
  // The payment is written on the same task: a second confirmation of the same piece that names the transaction.
  const confirms = stepsOf(relay, "confirm");
  expect(confirms).toHaveLength(2);
  const [, payment] = confirms;
  expect(tagOf(payment, "task")).toBe(task.id);
  expect(tagOf(payment, "task-evidence")).toBe(piece.id);
  const landed = await txOf(tagOf(payment, "task-paid") ?? "");
  expect(landed.to.toLowerCase()).toBe(project.treasury);
  expect(decodeCall(TREASURY_ABI, landed.input)?.args).toEqual([
    w.who.stranger,
    3n * DOLLAR,
  ]);
  await expect(page.getByTestId("task-paid")).toHaveText("Paid 3 dollars.", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-pay-owed")).toHaveCount(0);
  await expect(page.getByTestId("task-pay-section")).toHaveCount(0);
  await stranger.reload();
  await stranger.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(stranger.getByTestId("task-paid")).toHaveText(
    "Paid 3 dollars.",
    {
      timeout: 20_000,
    },
  );
  console.log(pay.summary("Pay from the box"));
});

test("a project run by two: one signer asks for the pay, the other reads which task it is for and confirms, and the payment is then found and saved on the task", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "taskpair", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 450n);
  // The founder and the teammate (whose wallet is the backer's account) run it together.
  const pairAddress = await state.pairAddressOf(
    read,
    w.chain.launcher,
    project.key,
    w.who.founder,
    w.who.backer,
  );
  const { walletOf } = await import("../anvil/pot-chain");
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
  await passTime(2000);
  await walletOf(w.who.founder).sendCalls(
    [pot.pairCheckInCall(pairAddress, `0x${"5d".repeat(32)}`)],
    31337,
  );
  const relay = createMockRelay();
  await seedTeamServer(relay, w, project, w.who.backer);
  relay.seed(profile(STRANGER, "Sam Stranger"));
  const { task, piece, step } = seedHandedIn(relay, project, w.who.stranger);
  // The work was accepted without its pay.
  relay.seed(step(FOUNDER_NOSTR, "confirm", [["task-evidence", piece.id]]));

  const founder = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  await expect(page.getByTestId("task-pay-owed")).toHaveText(
    "Accepted, pay owed: 3 dollars.",
    { timeout: 20_000 },
  );
  const ask = page.getByTestId("task-pay");
  await expect(ask).toHaveText("Ask for the pay from the box");
  await expect(page.getByTestId("task-pay-section")).toContainText(
    "This project is run by two.",
  );
  const owedBefore = await reads.balanceOf(
    read,
    project.dollar,
    w.who.stranger,
  );
  const events = relay.events.length;
  await ask.click();
  await expect(page.getByTestId("task-pay-asked")).toContainText(
    "when the other signer confirms",
    { timeout: 30_000 },
  );
  // One prompt: a proposal through the Pair. Nothing was drawn and nothing was written on the task.
  expect(founder.prompts).toBe(1);
  expect(founder.sent[0]?.to.toLowerCase()).toBe(pairAddress.toLowerCase());
  expect(decodeCall(PAIR_ABI, founder.sent[0]?.data ?? "")?.name).toBe(
    "propose",
  );
  expect(await reads.balanceOf(read, project.dollar, w.who.stranger)).toBe(
    owedBefore,
  );
  expect(relay.events.length).toBe(events);

  // The other signer reads, on the Money tab, what the draw is for, and confirms it.
  const matePage = await page.context().newPage();
  await openServer(matePage, relay, MATE_KEY);
  const mate = await installAnvilWallet(matePage, w.who.backer);
  await syncClock(matePage);
  await matePage.goto(pageOf(project.label));
  await matePage.getByTestId("tab-money").click({ timeout: 20_000 });
  const terms = matePage.getByTestId("pair-terms");
  await expect(terms).toContainText(`the pay for the task "${WHAT}"`, {
    timeout: 30_000,
  });
  await matePage.getByTestId("pair-review").click();
  await expect(matePage.getByTestId("pair-sheet-terms")).toContainText(
    `the pay for the task "${WHAT}"`,
  );
  await matePage.getByTestId("sheet-confirm").click();
  await expect(matePage.getByTestId("sheet-confirm")).toBeHidden({
    timeout: 30_000,
  });
  expect(mate.prompts).toBe(1);
  expect(await reads.balanceOf(read, project.dollar, w.who.stranger)).toBe(
    owedBefore + 3n * DOLLAR,
  );

  // Back on the task: the payment is found on the chain and offered for this task; saving writes it on the task.
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("task-pay-found")).toContainText(
    "A payment of 3 dollars",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("task-pay")).toHaveCount(0);
  await page.getByTestId("task-pay-save").click();
  await expect(page.getByTestId("toast")).toContainText("Paid 3 dollars.", {
    timeout: 20_000,
  });
  const confirms = stepsOf(relay, "confirm");
  expect(confirms).toHaveLength(2);
  const saved = confirms.at(-1);
  expect(tagOf(saved, "task")).toBe(task.id);
  expect(tagOf(saved, "task-evidence")).toBe(piece.id);
  // The transaction the task names is the other signer's confirmation, from the other signer's account, through the Pair.
  const landed = await txOf(tagOf(saved, "task-paid") ?? "");
  expect(landed.from.toLowerCase()).toBe(w.who.backer);
  expect(landed.to.toLowerCase()).toBe(pairAddress.toLowerCase());
  expect(founder.prompts).toBe(1);
  await expect(page.getByTestId("task-paid")).toHaveText("Paid 3 dollars.", {
    timeout: 20_000,
  });
});

test("an agent account on the team is never offered Accept or Post", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "taskagent", FOUNDER_NOSTR);
  const relay = createMockRelay();
  await serverFor(w, project, relay);
  // A newer version of the project's record naming the agent on its team.
  relay.seed(
    projectRecord(
      FOUNDER_NOSTR,
      project.label,
      "Lantern",
      "Solar lamps for night markets.",
      now() - 49 * DAY,
      [
        ["chain-key", project.key],
        ["team", AGENT, "engineer"],
      ],
    ),
  );
  // The agent's profile carries the label the server checked: its own key, and the signature of who runs it.
  relay.seed(
    event(
      0,
      AGENT,
      { name: "Mapper" },
      [
        ["agent", AGENT],
        ["auth", FOUNDER_NOSTR, "", "0".repeat(128)],
      ],
      now() - DAY,
    ),
  );
  seedHandedIn(relay, project, w.who.stranger);
  await openTasks(page, relay, project, AGENT_KEY, w.who.helper);
  await expect(page.getByTestId("task-state")).toHaveText("Work handed in", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-accept")).toHaveCount(0);
  await expect(page.getByTestId("task-new")).toHaveCount(0);
  await expectAccessible(page, "Tasks seen by an agent");
});

test("with money off, a task shows no dollars and nothing about money", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "taskoff", FOUNDER_NOSTR);
  const relay = createMockRelay();
  relay.seed(profile(FOUNDER_NOSTR, "Fay Founder"));
  relay.seed(
    projectRecord(
      FOUNDER_NOSTR,
      project.label,
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
      [["chain-key", project.key]],
    ),
  );
  seedHandedIn(relay, project, w.who.stranger);
  // The server does not turn investing on: no numbers are asked for and nothing about money shows.
  await install(page, relay, READER_KEY);
  await page.goto(pageOf(project.label));
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("task-card")).toContainText(WHAT, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-pays")).toHaveCount(0);
  await expect(page.getByTestId("task-pay-owed")).toHaveCount(0);
  await expect(page.getByText(/dollar/i)).toHaveCount(0);
});

test("the runner sets an agent's daily limits and switches it off, and a wallet that does not run the project sees no agent limits", async ({
  page,
  browser,
}) => {
  const w = world.get();
  const project = await launchProject(w, "taskcaps", FOUNDER_NOSTR);
  const relay = createMockRelay();
  await serverFor(w, project, relay);
  const agentWallet = w.who.helper;

  const runner = await openTasks(
    page,
    relay,
    project,
    FOUNDER_KEY,
    w.who.founder,
  );
  const caps = page.getByTestId("agent-caps");
  await expect(caps).toBeVisible({ timeout: 20_000 });
  await expectAccessible(page, "Agent limits");
  await expectNoSidewaysScroll(page, "Agent limits");
  await page.getByTestId("agent-address").fill(agentWallet);
  await page.getByTestId("agent-dollars").fill("25");
  await page.getByTestId("agent-shares").fill("5");
  await page.getByTestId("agent-set").click();
  await expect(page.getByTestId("toast")).toContainText(
    "The agent's limits are set.",
    { timeout: 30_000 },
  );
  // The Treasury holds exactly those limits, and the agent is on.
  const agentOf = async () =>
    decodeReturn(
      TREASURY_ABI,
      "agents",
      await read(
        project.treasury,
        encodeCall(TREASURY_ABI, "agents", [agentWallet]),
      ),
      1,
    );
  expect(await agentOf()).toEqual([true, 25n * DOLLAR, 5n * 10n ** 18n]);
  await page.getByTestId("agent-off").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "The agent is switched off." }),
  ).toBeVisible({ timeout: 30_000 });
  expect((await agentOf())[0]).toBe(false);
  expect(
    runner.sent.map(({ to, data }) => ({ to: to.toLowerCase(), data })),
  ).toEqual([
    {
      to: project.treasury,
      data: setAgentCall(project.treasury, agentWallet, 25, 5n * 10n ** 18n)
        .data,
    },
    {
      to: project.treasury,
      data: revokeAgentCall(project.treasury, agentWallet).data,
    },
  ]);

  // A wallet that does not run the project is offered no limits.
  const other = await phone(browser);
  await openTasks(other, relay, project, FOUNDER_KEY, w.who.backer);
  await expect(other.getByTestId("tasks-none")).toBeVisible({
    timeout: 20_000,
  });
  await expect(other.getByTestId("agent-caps")).toHaveCount(0);
});
