import { expect, test } from "@playwright/test";
import { decodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { PLAY_DOLLAR_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call } from "../anvil/rpc";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import {
  backFor,
  giveDollars,
  launchProject,
  NO_CHAIN_WHY,
} from "./helpers/live-chain";
import { FOUNDER_NOSTR, liveWorld, openMoney } from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * Back a project from a browser whose wallet is a real account on a real local chain (anvil, the pot contracts, the app's
 * own build): the Shares that land are the Shares the sheet quoted, the wallet is asked exactly once, and the presses are
 * counted. The server's record is a stand-in made from the chain by `helpers/live-record.ts`.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);

test(`Back with the wallet: ${PLAN_V2_BUDGETS.back.presses} presses, ${PLAN_V2_BUDGETS.back.fields} box, one wallet prompt, and the Shares are the quote`, async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "backone", FOUNDER_NOSTR);
  await giveDollars(w, w.who.backer);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });

  // What the chain would give for 25 dollars right now (the sheet reads the same view).
  const quote = await reads.quoteBack(read, project.treasury, 25_000_000n);
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(0n);

  const path = new PressCounter();
  await path.type(
    page.getByTestId("backing-amount"),
    "25",
    "How many dollars?",
  );
  await path.press(page.getByTestId("backing-review"), "Back");
  const sheet = page.getByTestId("back-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("back-shares")).toContainText("2,450 Shares");
  await path.read(page, "the Back sheet");
  await path.press(page.getByTestId("sheet-confirm"), "Back with 25 dollars");
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("holding-shares")).toContainText("2,450", {
    timeout: 20_000,
  });

  // One wallet prompt: the whole Back is one call on the play dollar.
  expect(wallet.prompts).toBe(1);
  expect(wallet.sent).toHaveLength(1);
  expect(decodeCall(PLAY_DOLLAR_ABI, wallet.sent[0].data)?.name).toBe(
    "transferAndCall",
  );
  expect(wallet.sent[0].to.toLowerCase()).toBe(project.dollar);

  // What landed on the chain is what the quote said, and the platform's part of it is owed to the platform.
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(
    quote.shares,
  );
  expect(await reads.balanceOf(read, project.dollar, w.who.backer)).toBe(
    975_000_000n,
  );
  expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.back.presses);
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.back.fields);
  console.log(
    `MEASURED Back, wallet: ${path.presses} presses, ${path.fields} field, ${wallet.prompts} wallet prompt`,
  );
});

test("a second backer pays the price the chain gives them, which is what lands", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "backtwo", FOUNDER_NOSTR);
  const first = await backFor(w, project, w.who.backer, 100n);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.second,
  });
  await giveDollars(w, w.who.second);
  const quote = await reads.quoteBack(read, project.treasury, 40_000_000n);
  await page.getByTestId("backing-amount").fill("40");
  await page.getByTestId("backing-review").click();
  await expect(page.getByTestId("back-shares")).toContainText("Shares");
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
  expect(wallet.sent).toHaveLength(1);
  // The price moves a little every second (the allowance flows out of the pot), so what lands is the quote read a moment
  // earlier to within the guard the sheet sent (0.5%), never below it.
  const landed = await reads.balanceOf(read, project.shares, w.who.second);
  expect(landed).toBeGreaterThanOrEqual((quote.shares * 995n) / 1000n);
  expect(landed).toBeLessThanOrEqual((quote.shares * 1005n) / 1000n);
  // The first backer's Shares did not move.
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(first);
});

test("a wallet that says no sends nothing, the sheet says so, and the next press goes through", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "refuse", FOUNDER_NOSTR);
  await giveDollars(w, w.who.backer);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });
  wallet.rejectNext = 1;
  await page.getByTestId("backing-amount").fill("10");
  await page.getByTestId("backing-review").click();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("sheet-problem")).toBeVisible();
  expect(wallet.prompts).toBe(1);
  expect(wallet.sent).toHaveLength(0);
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(0n);
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
  expect(wallet.prompts).toBe(2);
  expect(wallet.sent).toHaveLength(1);
  expect(
    await reads.balanceOf(read, project.shares, w.who.backer),
  ).toBeGreaterThan(0n);
});

test("pressing twice at once asks the wallet once and backs once", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "double", FOUNDER_NOSTR);
  await giveDollars(w, w.who.backer);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });
  wallet.delayMs = 700;
  const quote = await reads.quoteBack(read, project.treasury, 10_000_000n);
  await page.getByTestId("backing-amount").fill("10");
  await page.getByTestId("backing-review").click();
  const confirm = page.getByTestId("sheet-confirm");
  await expect(page.getByTestId("back-shares")).toBeVisible();
  await confirm.dblclick();
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
  expect(wallet.prompts).toBe(1);
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(
    quote.shares,
  );
});

test("an amount under the smallest, and more play dollars than the person has, are said before anything is sent", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "limits", FOUNDER_NOSTR);
  await giveDollars(w, w.who.backer);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });
  await page.getByTestId("backing-amount").fill("0.5");
  await page.getByTestId("backing-review").click();
  await expect(page.getByText("The smallest amount is 1 dollar")).toBeVisible();
  await expect(page.getByTestId("back-sheet")).toHaveCount(0);
  await page.getByTestId("backing-amount").fill("5000");
  await page.getByTestId("backing-review").click();
  await expect(page.getByTestId("back-short")).toContainText(
    "less than the 5,000 this needs",
  );
  await expect(page.getByTestId("sheet-confirm")).toBeDisabled();
  expect(wallet.prompts).toBe(0);
});
