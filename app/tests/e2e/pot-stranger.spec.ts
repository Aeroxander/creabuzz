import { expect, test } from "@playwright/test";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call } from "../anvil/rpc";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { backFor, launchProject, NO_CHAIN_WHY } from "./helpers/live-chain";
import { FOUNDER_NOSTR, liveWorld, openMoney } from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * A stranger opens a project page and reads what it says about money and what the Back sheet shows, without sending
 * anything; then the whole first visit of someone with a wallet and no play dollars: get play dollars (one press), Back, Take
 * out, counted in presses, typed boxes and wallet prompts. A real chain under a real browser.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const NOTICE =
  "This is a test network. The dollars are play money, not real money.";
const LEGAL =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";

test("a stranger in a browser with no wallet reads the money, the risk and the legal line, and is told what to do to back", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "nowallet", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  await openMoney(page, w, project, { account: null });
  await expect(page.getByTestId("play-money")).toContainText(NOTICE);
  await expect(page.getByTestId("money-pot")).toBeVisible();
  await expect(page.getByTestId("money-share-value")).toBeVisible();
  await expect(page.getByTestId("money-now")).toContainText(
    "This can go up or down. It is not a return.",
  );
  await expect(page.getByTestId("money-state")).toHaveText("Open");
  await expect(page.getByTestId("ownership").first()).toHaveText(LEGAL);
  // Back is there, and says what is missing instead of offering a press that cannot work.
  await expect(page.getByTestId("backing-box")).toContainText(
    "Open this page in a browser with a wallet to back this project",
  );
  await expect(page.getByTestId("backing-amount")).toHaveCount(0);
});

test("a stranger with a wallet and no play dollars reads the Back sheet and sends nothing", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "readsheets", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.stranger,
  });
  // The faucet is one press on the page, and nothing is sent until it is pressed.
  await expect(page.getByTestId("faucet-open")).toHaveText("Get play dollars");
  // The Back sheet says what you pay, the Shares and what taking out now would give.
  await page.getByTestId("backing-amount").fill("25");
  await page.getByTestId("backing-review").click();
  const sheet = page.getByTestId("back-sheet");
  await expect(page.getByTestId("back-pay")).toHaveText("25 dollars");
  await expect(page.getByTestId("back-shares")).toContainText("Shares");
  await expect(page.getByTestId("back-now")).toContainText("dollars");
  await expect(sheet).toContainText(
    "This can go up or down. It is not a return.",
  );
  await expect(sheet.getByTestId("sheet-play-money")).toContainText(NOTICE);
  await expect(sheet.getByTestId("ownership")).toHaveText(LEGAL);
  // No play dollars yet: the sheet says so and does not offer the press.
  await expect(page.getByTestId("back-short")).toContainText(
    /You hold 0(\.00)? play dollars/,
  );
  await expect(page.getByTestId("sheet-confirm")).toBeDisabled();
  expect(wallet.prompts).toBe(0);
  expect(await reads.balanceOf(read, project.shares, w.who.stranger)).toBe(0n);
});

test("the first visit of someone with a wallet and nothing else: play dollars, Back, Take out", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "firstvisit", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  // The page alone, with no Money tab: the Back box and, once they hold Shares, Take out are in its top.
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.helper,
    tab: null,
  });
  // Three parts, counted apart: the faucet (a test-network step, once), then the 30-second test of the design, Back and Take out.
  const faucet = new PressCounter();
  const path = new PressCounter();
  const dollar = (who: string) => reads.balanceOf(read, project.dollar, who);
  expect(await dollar(w.who.helper)).toBe(0n);

  // Play dollars from the faucet.
  await faucet.press(page.getByTestId("faucet-open"), "Get play dollars");
  await expect(page.getByTestId("faucet-open")).toBeHidden({
    timeout: 30_000,
  });
  expect(await dollar(w.who.helper)).toBe(1_000_000_000n);

  // Back.
  await path.type(
    page.getByTestId("backing-amount"),
    "25",
    "How many dollars?",
  );
  await path.press(page.getByTestId("backing-review"), "Back");
  await path.read(page, "the Back sheet");
  await path.press(page.getByTestId("sheet-confirm"), "Back with 25 dollars");
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("holding-shares")).not.toHaveText("0", {
    timeout: 20_000,
  });
  expect(
    await reads.balanceOf(read, project.shares, w.who.helper),
  ).toBeGreaterThan(0n);

  // Take out, all of it.
  await path.press(page.getByTestId("holding-take-out"), "Take out");
  await path.read(page, "the Take out sheet");
  await path.press(page.getByTestId("sheet-confirm"), "Take out");
  await expect(page.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(await reads.balanceOf(read, project.shares, w.who.helper)).toBe(0n);
  await expect(page.getByTestId("holding-take-out")).toBeHidden({
    timeout: 20_000,
  });

  // The wallet was asked exactly three times: the faucet, the Back, the Take out.
  expect(wallet.prompts).toBe(3);
  expect(faucet.presses).toBe(PLAN_V2_BUDGETS.faucet.presses);
  expect(path.presses).toBe(4);
  expect(path.fields).toBe(1);
  console.log(faucet.summary("faucet (wallet)"));
  console.log(path.summary("Back then Take out (wallet)"));
  console.log(
    `MEASURED first visit, wallet: faucet ${faucet.presses} presses; Back and Take out ${path.presses} presses, ${path.fields} field; ${wallet.prompts} wallet prompts in all`,
  );
});
