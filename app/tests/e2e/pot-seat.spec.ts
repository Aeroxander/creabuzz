import { type Page, expect, test } from "@playwright/test";
import { decodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { call } from "../anvil/rpc";
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
  openMoney,
  openServer,
  pageOf,
  syncClock,
  type LiveServer,
} from "./helpers/live-browser";
import { installAnvilWallet, type WalletLog } from "./helpers/live-wallet";
import {
  FOUNDER_NAME,
  MATE_KEY,
  MATE_NAME,
  seedTeamServer,
} from "./helpers/live-team";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * Who runs the money, on a real local chain in a real browser: winding a project down (by its runner, with the words that say
 * first that taking out stays open; by anyone after half a year of quiet; through a Pair, where the other signer reads the
 * call in words and confirms it), handing the seat to a teammate (offer, withdraw, take it from the teammate's own page) and
 * making a Pair (ask, accept, and the project then says two run it).
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);

/** A page of a person on the team: signed in as `key`, with `account` as the wallet, on the project's Money tab. */
async function openTeamPage(
  page: Page,
  w: LiveWorld,
  project: LiveProject,
  who: { key: string | null; account: string | null },
) {
  const relay = createMockRelay();
  const server: LiveServer = await seedTeamServer(
    relay,
    w,
    project,
    w.who.backer,
  );
  await openServer(page, relay, who.key);
  const wallet: WalletLog = await installAnvilWallet(page, who.account);
  await syncClock(page);
  await page.goto(pageOf(project.label));
  await page.getByTestId("tab-money").click({ timeout: 20_000 });
  await expect(page.getByTestId("seat-section")).toBeVisible({
    timeout: 20_000,
  });
  return { relay, server, wallet };
}

const seatOf = (project: LiveProject) =>
  state.readSeatState(read, project.treasury);

test("the runner winds a project down: two presses, one signature, what it does to backers is said first, and taking out stays open", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "windchoice", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  await checkIn(w, project);
  const { wallet } = await openTeamPage(page, w, project, {
    key: FOUNDER_KEY,
    account: w.who.founder,
  });
  await expect(page.getByTestId("seat-runs")).toContainText(
    `${FOUNDER_NAME} runs the project's money`,
  );
  await expectAccessible(page, "Who runs the money, runner");
  await page.getByTestId("seat-section").screenshot({
    path: "test-results/pot-screens/seat-section.png",
  });
  const path = new PressCounter();
  await path.press(page.getByTestId("seat-wind-down"), "Wind down");
  const sheet = page.getByTestId("wind-down-sheet");
  await expect(sheet).toBeVisible();
  const terms = page.getByTestId("wind-down-terms");
  // What it does to backers comes first, before the press, and says taking out stays open.
  await expect(terms.locator("li").first()).toContainText(
    "Taking out stays open. Everyone who holds Shares can still take their money out",
  );
  await expect(terms).toContainText(
    "Winding down is for good. It cannot be undone.",
  );
  await expect(terms).toContainText("Nobody can back the project any more");
  await expect(page.getByTestId("sheet-play-money")).toContainText(
    "play money",
  );
  await expect(sheet.getByTestId("ownership")).toContainText(
    "Buyers acquire ownership only: governance and exit.",
  );
  await expectAccessible(page, "Wind down sheet");
  await page.screenshot({
    path: "test-results/pot-screens/wind-down-sheet.png",
  });
  await path.read(page, "the wind-down sheet");
  expect(wallet.prompts).toBe(0);
  await path.press(
    page.getByTestId("sheet-confirm"),
    "Wind down Lantern for good",
  );
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  expect(path.presses).toBe(2);
  expect(path.fields).toBe(0);
  expect(wallet.prompts).toBe(1);
  expect(wallet.sent[0]?.to).toBe(w.chain.launcher);
  const sent = decodeCall(LAUNCHER_ABI, wallet.sent[0]?.data ?? "");
  expect(sent?.name).toBe("windDown");
  expect(sent?.args).toEqual([project.key]);
  expect((await seatOf(project)).windDownKind).toBe(1);
  // The page says so and offers nothing more to do about it.
  await expect(page.getByTestId("seat-section")).toContainText(
    "This project has wound down",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("seat-wind-down")).toHaveCount(0);
  // A backer still takes everything out, in the browser, after the wind-down.
  const backerPage = await page.context().newPage();
  const held = await reads.balanceOf(read, project.shares, w.who.second);
  expect(held).toBeGreaterThan(0n);
  const second = await openMoney(backerPage, w, project, {
    account: w.who.second,
  });
  await backerPage.getByTestId("holding-take-out").click();
  await backerPage.getByTestId("sheet-confirm").click();
  await expect(backerPage.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(await reads.balanceOf(read, project.shares, w.who.second)).toBe(0n);
  expect(second.wallet.prompts).toBe(1);
  console.log(
    `MEASURED Wind down by the runner: ${path.presses} presses, ${path.fields} fields, ${wallet.prompts} wallet prompt`,
  );
});

test("after half a year of quiet anyone may wind a project down, and the sheet says why", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "windquiet", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  await checkIn(w, project);
  await passTime(27 * w.chain.unit);
  const { wallet } = await openTeamPage(page, w, project, {
    key: null,
    account: w.who.stranger,
  });
  await expect(page.getByTestId("seat-quiet")).toContainText(
    "quiet for about half a year, so anyone can wind the project down",
  );
  // Not the runner: no runner buttons.
  await expect(page.getByTestId("seat-runner")).toHaveCount(0);
  await page.getByTestId("seat-wind-down").click();
  await expect(page.getByTestId("wind-down-why")).toContainText(
    "The team has not checked in since",
  );
  await expect(page.getByTestId("wind-down-terms")).toContainText(
    "What has unlocked stays with its member",
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("wind-down-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(wallet.prompts).toBe(1);
  expect(wallet.sent[0]?.to).toBe(project.treasury);
  expect(decodeCall(TREASURY_ABI, wallet.sent[0]?.data ?? "")?.name).toBe(
    "windDown",
  );
  expect((await seatOf(project)).windDownKind).toBe(2);
});

test("the founder offers the seat to a teammate, withdraws it, offers again, and the teammate takes it from their own page", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "handover", FOUNDER_NOSTR);
  await checkIn(w, project);
  const founder = await openTeamPage(page, w, project, {
    key: FOUNDER_KEY,
    account: w.who.founder,
  });
  const offer = async (path: PressCounter) => {
    await path.press(page.getByTestId("seat-hand-over"), "Hand over the seat");
    await expect(page.getByTestId("offer-sheet")).toBeVisible();
    await page.getByTestId("offer-member").selectOption({ label: MATE_NAME });
    path.fields += 1; // the person is chosen from a list: one field
    await expect(page.getByTestId("offer-terms")).toContainText(
      `${MATE_NAME} (${w.who.backer}) can take the seat`,
    );
    await expect(page.getByTestId("offer-lasts")).toContainText(
      "The offer lasts about 56 minutes.",
    );
    await path.press(page.getByTestId("sheet-confirm"), "Offer the seat");
    await expect(page.getByTestId("offer-sheet")).toBeHidden({
      timeout: 30_000,
    });
  };
  const first = new PressCounter();
  await offer(first);
  expect(first.presses).toBe(2);
  expect(founder.wallet.prompts).toBe(1);
  expect((await seatOf(project)).offeredTo).toBe(w.who.backer);
  // The founder reads the offer, can only withdraw it, and does.
  await expect(page.getByTestId("seat-offer-open")).toContainText(
    `The seat is offered to ${MATE_NAME}.`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("seat-hand-over")).toHaveCount(0);
  await page.getByTestId("seat-withdraw").click();
  await expect(page.getByTestId("withdraw-terms")).toContainText(
    `${MATE_NAME} can no longer take the seat.`,
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("withdraw-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect((await seatOf(project)).offeredTo).toBeNull();
  await expect(page.getByTestId("seat-hand-over")).toBeVisible({
    timeout: 20_000,
  });
  // Offered again, the teammate takes it.
  await offer(new PressCounter());
  const mate = await page.context().newPage();
  const second = await openTeamPage(mate, w, project, {
    key: MATE_KEY,
    account: w.who.backer,
  });
  await expect(mate.getByTestId("seat-offered-to-me")).toContainText(
    `${FOUNDER_NAME} offered you the seat that runs Lantern's money.`,
    { timeout: 20_000 },
  );
  await expectAccessible(mate, "Offered the seat");
  const path = new PressCounter();
  await path.press(mate.getByTestId("seat-take"), "Take the seat");
  await expect(mate.getByTestId("take-seat-terms")).toContainText(
    "Helpers the earlier runner set up stop working",
  );
  await path.press(mate.getByTestId("sheet-confirm"), "Take the seat");
  await expect(mate.getByTestId("take-seat-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(path.presses).toBe(2);
  expect(second.wallet.prompts).toBe(1);
  expect((await seatOf(project)).runner).toBe(w.who.backer);
  // The server reads the new runner; the founder no longer runs it: no buttons, and the words say who does.
  await founder.server.republish();
  await page.reload();
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("seat-runs")).toContainText(
    `${MATE_NAME} runs the project's money`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("seat-runner")).toHaveCount(0);
  console.log(
    `MEASURED Hand over: ${first.presses} presses, 1 field, 1 prompt to offer; ${path.presses} presses, 0 fields, 1 prompt to take`,
  );
});

test("the founder asks a teammate to run it together, the teammate accepts, and a wind-down needs both of them: one proposes, the other reads it in words and confirms", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "pairup", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  await checkIn(w, project);
  const founder = await openTeamPage(page, w, project, {
    key: FOUNDER_KEY,
    account: w.who.founder,
  });
  const ask = new PressCounter();
  await ask.press(
    page.getByTestId("seat-pair"),
    "Run it together with someone",
  );
  await page.getByTestId("offer-member").selectOption({ label: MATE_NAME });
  await expect(page.getByTestId("offer-terms")).toContainText(
    "Running it together means both of you must agree to every step that moves money",
  );
  await expect(page.getByTestId("sheet-confirm")).toHaveText(
    `Ask ${MATE_NAME} to run it with you`,
  );
  await expect(page.getByTestId("sheet-confirm")).toBeEnabled();
  await ask.press(page.getByTestId("sheet-confirm"), "Ask");
  await expect(page.getByTestId("offer-sheet")).toBeHidden({ timeout: 30_000 });
  expect(founder.wallet.prompts).toBe(1);
  const pairAddress = await state.pairAddressOf(
    read,
    w.chain.launcher,
    project.key,
    w.who.founder,
    w.who.backer,
  );
  expect((await seatOf(project)).offeredTo).toBe(pairAddress);
  await expect(page.getByTestId("seat-offer-open")).toContainText(
    `The seat is offered to ${MATE_NAME}, to run it together with you.`,
    { timeout: 20_000 },
  );

  // The teammate accepts the second seat from their own page.
  const matePage = await page.context().newPage();
  const mate = await openTeamPage(matePage, w, project, {
    key: MATE_KEY,
    account: w.who.backer,
  });
  await expect(matePage.getByTestId("seat-offered-pair")).toContainText(
    `${FOUNDER_NAME} asked you to run Lantern's money together.`,
    { timeout: 20_000 },
  );
  const accept = new PressCounter();
  await accept.press(
    matePage.getByTestId("seat-accept"),
    "Accept the second seat",
  );
  await expect(matePage.getByTestId("take-seat-sheet")).toContainText(
    "both of you must agree to every step that moves money",
  );
  await accept.press(
    matePage.getByTestId("sheet-confirm"),
    "Run Lantern together",
  );
  await expect(matePage.getByTestId("take-seat-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(mate.wallet.prompts).toBe(1);
  expect((await seatOf(project)).runner).toBe(pairAddress);

  // The server reads the new runner; both pages now say two run it.
  await founder.server.republish();
  await mate.server.republish();
  await page.reload();
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("seat-runs")).toContainText(
    `${FOUNDER_NAME} and ${MATE_NAME} run the project's money together.`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("seat-pair-meaning")).toContainText(
    "Either of you can still check in alone.",
  );
  await expect(page.getByTestId("seat-pair")).toHaveCount(0);

  // The founder proposes the wind-down: the sheet says the other signer must confirm, and nothing is wound down yet.
  await page.getByTestId("seat-wind-down").click();
  await expect(page.getByTestId("wind-down-sheet")).toContainText(
    "This project is run by two. Pressing asks the other signer: nothing happens until they confirm the same step.",
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("wind-down-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect((await seatOf(project)).windDownKind).toBe(0);

  // The other signer reads the waiting call in words naming what it does, and confirms exactly it.
  await matePage.reload();
  await matePage.getByTestId("tab-money").click();
  const waiting = matePage.getByTestId("pair-waiting-call");
  await expect(waiting).toBeVisible({ timeout: 30_000 });
  await expect(matePage.getByTestId("pair-terms")).toContainText(
    "Wind the project down, for good.",
  );
  await expect(matePage.getByTestId("pair-terms")).toContainText(
    "People who hold Shares can still take their money out.",
  );
  await matePage.getByTestId("pair-review").click();
  await expect(matePage.getByTestId("pair-sheet-terms")).toContainText(
    "Wind the project down, for good.",
  );
  await matePage.getByTestId("sheet-confirm").click();
  await expect(matePage.getByTestId("sheet-confirm")).toBeHidden({
    timeout: 30_000,
  });
  expect((await seatOf(project)).windDownKind).toBe(1);
  expect(mate.wallet.prompts).toBe(2);
  await expectNoSidewaysScroll(matePage, "Money tab, Pair");
  console.log(
    `MEASURED Make a Pair: ${ask.presses} presses to ask (1 field, 1 prompt), ${accept.presses} to accept (1 prompt); wind-down: 2 presses to propose, 2 to confirm`,
  );
});
