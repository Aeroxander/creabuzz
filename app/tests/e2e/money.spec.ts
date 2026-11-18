import { expect, type Page, test } from "@playwright/test";
import { selectorOf } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  backCalls,
  checkInCall,
  openBackingCall,
  refundCall,
} from "../../src/features/money/calls";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  BACKER_EVM,
  CONTRACTS,
  chainIdentity,
  FOUNDER_EVM,
} from "../helpers/numbers-fixture";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import {
  chainKeyTag,
  installWallet,
  RELAY,
  seedNumbers,
  sentCalls,
} from "./helpers/money-world";
import {
  coordOf,
  DAY,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/world";

/**
 * Money in the app where the server turns investing on: the project's numbers from the server's reading of the chain,
 * the Back box, receipts and the refund on You, Open backing, and This week's update with its check-in. Each path is
 * press-counted against plan v2's budgets. The wallet is a stand-in that records what it is asked to send, so the
 * exact calls are checked; a wallet's own confirmations are the wallet's, not presses in the app.
 */

const FOUNDER_KEY = "a1".repeat(32);
const READER_KEY = "a2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const READER = pubkeyOf(READER_KEY);
const COORD = coordOf(FOUNDER, "lantern");
const PROJECT = projectLink(FOUNDER, "lantern");
const OWNERSHIP =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";

function seed(relay: Relay, numbers: Parameters<typeof seedNumbers>[1] | null) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(READER, "Rae Reader"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
      [chainKeyTag(COORD)],
    ),
  );
  if (numbers) seedNumbers(relay, numbers);
}

async function openWith(
  page: Page,
  relay: Relay,
  key: string | null,
  wallet: Parameters<typeof installWallet>[1] | null,
) {
  await install(page, relay, key, { investing: true, relaySelf: RELAY });
  if (wallet) await installWallet(page, wallet);
}

async function greens(page: Page) {
  return page.locator(".btn-primary:visible").count();
}

test("a project's numbers show on its page and its open round on Home", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, {
    coordinate: COORD,
    openRound: { openedAgo: 3600, asked: "25000000", backers: 1 },
  });
  await openWith(page, relay, READER_KEY, null);
  await page.goto("/");
  const round = page.getByTestId("open-round");
  await expect(round).toContainText("Lantern", { timeout: 20_000 });
  await expect(round).toContainText("Round 2 open until");
  await expect(round).toContainText("1 dollar buys 3,000 Shares");
  await page.goto(PROJECT);
  await expect(page.getByTestId("stage-backed")).toHaveAttribute(
    "data-reached",
    "now",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("back-box")).toBeVisible();
  // Back is the screen's one green button; Ask to join steps back.
  expect(await greens(page)).toBe(1);
  await expect(page.getByTestId("join-ask")).toHaveClass(/btn-secondary/);
  await page.getByTestId("tab-money").click();
  const money = page.getByTestId("money-tab");
  await expect(money.getByTestId("money-raised")).toContainText(
    "2,500 of 10,000 dollars raised",
  );
  await expect(money.getByTestId("money-rounds")).toContainText(
    "1 dollar buys 3,000 Shares (333,333.33 for the whole project)",
  );
  await expect(money.getByTestId("money-open-round")).toContainText(
    "Round 2 is open until",
  );
  await expect(money.getByTestId("money-held")).toContainText(
    "200,300,000 Shares are held for 2 accounts",
  );
  await expect(money.getByTestId("money-clock")).toContainText("Last check-in");
  await expect(money.getByTestId("ownership")).toHaveText(OWNERSHIP);
  await expectNoSidewaysScroll(page, "Project money");
});

test("numbers signed by any key but the server's are not shown", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, null);
  seedNumbers(
    relay,
    { coordinate: COORD, openRound: { openedAgo: 3600 } },
    pubkeyOf("f1".repeat(32)),
  );
  await openWith(page, relay, READER_KEY, null);
  await page.goto("/");
  await expect(page.getByTestId("rounds-none")).toBeVisible({
    timeout: 20_000,
  });
  await page.goto(PROJECT);
  await expect(page.getByTestId("project-name")).toHaveText("Lantern", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("back-box")).toHaveCount(0);
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("money-none")).toContainText("No backing yet");
});

test("with investing off nothing about money is asked for or shown", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD, openRound: { openedAgo: 3600 } });
  await install(page, relay, FOUNDER_KEY);
  await installWallet(page, { account: FOUNDER_EVM });
  for (const path of ["/", PROJECT, "/week", "/you"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(page.getByText(OWNERSHIP)).toHaveCount(0);
    await expect(page.getByText(/backing|Back this|receipt/i)).toHaveCount(0);
  }
  expect(relay.requestsFor(39009), "no record of numbers is read").toBe(0);
});

test(`Back: ${PLAN_V2_BUDGETS.back.presses} presses and ${PLAN_V2_BUDGETS.back.fields} field, approve then ask`, async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD, openRound: { openedAgo: 3600 } });
  await openWith(page, relay, READER_KEY, { account: BACKER_EVM });
  await page.goto(PROJECT);
  await expect(page.getByTestId("back-box")).toBeVisible({ timeout: 20_000 });
  const path = new PressCounter();
  await path.type(page.getByTestId("back-amount"), "25", "How many dollars?");
  await path.press(page.getByTestId("back-review"), "Back");
  const sheet = page.getByTestId("back-sheet");
  await expect(sheet).toContainText("You get about 75,000 Shares");
  await expect(sheet).toContainText(
    "0.75 to the platform, 3.75 to the project now, and 20.50 released",
  );
  await expect(sheet).toContainText("At most 19.47 of your 25 can come back");
  await expect(sheet).toContainText("cancels the Shares held for it");
  await expect(sheet.getByTestId("ownership")).toHaveText(OWNERSHIP);
  await path.read(page, "the Back sheet");
  await path.press(page.getByTestId("back-confirm"), "Back with 25 dollars");
  await expect(page.getByTestId("toast")).toContainText("Backed", {
    timeout: 20_000,
  });
  const sent = await sentCalls(page);
  const expected = backCalls({
    quote: CONTRACTS.quote,
    rounds: CONTRACTS.rounds,
    round: 2,
    amount: 25_000_000n,
  });
  expect(sent.map(({ to, data, value }) => ({ to, data, value }))).toEqual(
    expected,
  );
  expect(sent.every((c) => c.from === BACKER_EVM)).toBe(true);
  console.log(path.summary("Back"));
  expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.back.presses);
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.back.fields);
});

test("Back says a contract refusal in plain words and keeps the sheet open", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD, openRound: { openedAgo: 3600 } });
  await openWith(page, relay, READER_KEY, {
    account: BACKER_EVM,
    refuseNextWith: `${selectorOf("WrongPhase()")}`,
  });
  await page.goto(PROJECT);
  await page.getByTestId("back-amount").fill("1", { timeout: 20_000 });
  await page.getByTestId("back-review").click();
  await page.getByTestId("back-confirm").click();
  await expect(page.getByTestId("back-problem")).toHaveText(
    "This round is not taking asks any more, so nothing was taken.",
  );
  await expect(page.getByTestId("back-sheet")).toBeVisible();
  expect(await sentCalls(page)).toHaveLength(0);
});

test(`Take money back: ${PLAN_V2_BUDGETS.takeMoneyBack.presses} presses, nothing typed, from the receipt on You`, async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD });
  await openWith(page, relay, READER_KEY, { account: BACKER_EVM });
  await page.goto("/you");
  const receipt = page.getByTestId("receipt");
  await expect(receipt).toContainText("Paid 100 dollars in round 1.", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("receipt-refund")).toContainText(
    "Can still take back 58.63 dollars (58.64 of each 100), as of",
  );
  await expect(page.getByTestId("receipt-shares")).toContainText(
    "300,000 held for you, 0 free.",
  );
  await expect(page.getByTestId("receipt-project")).toContainText("Lantern");
  const path = new PressCounter();
  await path.press(page.getByTestId("receipt-take-back"), "Take money back");
  const sheet = page.getByTestId("refund-sheet");
  await expect(sheet).toContainText(
    "The Shares still held for you in round 1 are cancelled.",
  );
  await path.read(page, "the refund sheet");
  await path.press(page.getByTestId("refund-confirm"), "Take back");
  await expect(page.getByTestId("toast")).toContainText("on its way back", {
    timeout: 20_000,
  });
  const sent = await sentCalls(page);
  expect(sent.map(({ to, data, value }) => ({ to, data, value }))).toEqual([
    refundCall(CONTRACTS.rounds, 1),
  ]);
  console.log(path.summary("Take money back"));
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.takeMoneyBack.presses,
  );
  expect(path.fields).toBe(PLAN_V2_BUDGETS.takeMoneyBack.fields);
});

test("You with a wallet that shares no account offers to connect it, never 'none'", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD });
  await openWith(page, relay, READER_KEY, { account: null });
  await page.goto("/you");
  await expect(page.getByTestId("receipts-connect")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Connect your wallet" }).click();
  await expect(page.getByTestId("receipts-none")).toContainText(
    "This wallet has not backed a project yet.",
  );
});

test(`Open backing: ${PLAN_V2_BUDGETS.openBacking.presses} press at exactly 3e15 Shares a raw dollar`, async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD });
  await openWith(page, relay, FOUNDER_KEY, { account: FOUNDER_EVM });
  await page.goto(PROJECT);
  await expect(page.getByTestId("open-backing")).toContainText(
    "Up to 7,500 dollars",
    { timeout: 20_000 },
  );
  expect(await greens(page)).toBe(1);
  const path = new PressCounter();
  await path.press(page.getByTestId("open-backing-press"), "Open backing");
  await expect(page.getByTestId("toast")).toContainText("open for 24 hours", {
    timeout: 20_000,
  });
  const sent = await sentCalls(page);
  const { key } = chainIdentity(COORD);
  expect(sent.map(({ to, data, value }) => ({ to, data, value }))).toEqual([
    openBackingCall(CONTRACTS.launcher, key, 3_000_000_000_000_000n),
  ]);
  console.log(path.summary("Open backing"));
  expect(path.presses).toBe(PLAN_V2_BUDGETS.openBacking.presses);
  expect(path.fields).toBe(PLAN_V2_BUDGETS.openBacking.fields);
});

test(`Weekly update with check-in: ${PLAN_V2_BUDGETS.weeklyUpdate.presses} presses and ${PLAN_V2_BUDGETS.weeklyUpdate.fields} field`, async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD });
  await openWith(page, relay, FOUNDER_KEY, { account: FOUNDER_EVM });
  await page.goto("/week");
  const card = page.getByTestId("week-project");
  await expect(card.getByTestId("week-clock")).toContainText("Last check-in", {
    timeout: 20_000,
  });
  await expect(card.getByTestId("week-open")).toHaveText(
    "Post this week's update and check in",
  );
  const path = new PressCounter();
  await path.press(card.getByTestId("week-open"), "Post this week's update");
  await path.type(
    page.getByTestId("weekly-text"),
    "Lit ten stalls and fixed the charger.",
    "What did you do this week?",
  );
  await path.read(page, "the weekly sheet");
  await path.press(page.getByTestId("weekly-post"), "Post and check in");
  await expect(page.getByTestId("toast")).toContainText(
    "Posted and checked in",
    { timeout: 20_000 },
  );
  const updates = relay.events.filter(
    (e) => e.kind === 47003 && e.pubkey === FOUNDER,
  );
  expect(updates).toHaveLength(1);
  expect(updates[0].tags).toContainEqual(["a", COORD]);
  expect(updates[0].tags).toContainEqual([
    "update-part",
    "done",
    "Lit ten stalls and fixed the charger.",
  ]);
  const sent = await sentCalls(page);
  expect(sent.map(({ to, data, value }) => ({ to, data, value }))).toEqual([
    checkInCall(CONTRACTS.treasury),
  ]);
  console.log(path.summary("Weekly update with check-in"));
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.weeklyUpdate.presses,
  );
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.weeklyUpdate.fields);
});

test("a check-in that fails after the update posted says so and offers only the check-in again", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, { coordinate: COORD });
  await openWith(page, relay, FOUNDER_KEY, {
    account: FOUNDER_EVM,
    refuseNextWith: selectorOf("NotAllowed()"),
  });
  await page.goto("/week");
  await page.getByTestId("week-open").click({ timeout: 20_000 });
  await page.getByTestId("weekly-text").fill("Quiet week, still at it.");
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("weekly-problem")).toHaveText(
    "Your update is posted; the check-in did not go through. Only the person who runs the project can check in.",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("weekly-text")).toHaveCount(0);
  await expect(page.getByTestId("weekly-post")).toHaveText("Check in again");
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("toast")).toContainText(
    "Posted and checked in",
    { timeout: 20_000 },
  );
  // One update, however many tries the check-in took.
  expect(
    relay.events.filter((e) => e.kind === 47003 && e.pubkey === FOUNDER),
  ).toHaveLength(1);
  expect(await sentCalls(page)).toHaveLength(1);
});

test("without a launch, This week posts the update alone and says nothing about a check-in on the network", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, null);
  await openWith(page, relay, FOUNDER_KEY, null);
  await page.goto("/week");
  await expect(page.getByTestId("week-open")).toHaveText(
    "Post this week's update",
    { timeout: 20_000 },
  );
  await page.getByTestId("week-open").click();
  await page.getByTestId("weekly-text").fill("Built the stand.");
  await expect(page.getByTestId("weekly-post")).toHaveText("Post");
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("toast")).toHaveText("Posted", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("week-last-update")).toHaveText(
    "Updated today",
    { timeout: 20_000 },
  );
});
