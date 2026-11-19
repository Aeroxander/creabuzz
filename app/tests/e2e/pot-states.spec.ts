import { expect, test } from "@playwright/test";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call } from "../anvil/rpc";
import {
  backFor,
  checkIn,
  launchProject,
  NO_CHAIN_WHY,
  passTime,
} from "./helpers/live-chain";
import {
  FOUNDER_NOSTR,
  liveWorld,
  openMoney,
  pageOf,
} from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * What a person sees when the server's reading of a project is old, cannot be read, or is not there, and that the play-money
 * notice is on every money screen. A real chain under a real browser; the server's record is made from the chain with the
 * age or the failure the spec names.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const NOTICE =
  "This is a test network. The dollars are play money, not real money.";
const DAY = 86_400;

test("a record a day old says when it was read, and one two days old pauses Back and leaves Take out open", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "oldrecord", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await checkIn(w, project);
  const stale = await openMoney(page, w, project, {
    account: w.who.backer,
    patch: (c) => {
      c.builtAt = (c.builtAt as number) - 2 * DAY;
    },
  });
  // Older than a day: the figures are gone, the page says it could not refresh and that the money is not affected.
  await expect(page.getByTestId("money-stale")).toContainText(
    "have not been able to refresh",
  );
  await expect(page.getByTestId("money-stale")).toContainText(
    "you can take it out any time",
  );
  await expect(page.getByTestId("money-pot")).toHaveCount(0);
  await expect(page.getByTestId("back-paused")).toContainText("Backing waits");
  await expect(page.getByTestId("backing-amount")).toHaveCount(0);
  await expect(page.getByTestId("play-money")).toContainText(NOTICE);
  // Take out does not wait for the server.
  const before = await reads.balanceOf(read, project.dollar, w.who.backer);
  await page.getByTestId("holding-take-out").click();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(
    await reads.balanceOf(read, project.dollar, w.who.backer),
  ).toBeGreaterThan(before);
  expect(stale.wallet.prompts).toBe(1);
});

test("a record a few hours old is shown with the time it is as of", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "asof", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, {
    account: w.who.backer,
    patch: (c) => {
      c.builtAt = (c.builtAt as number) - 3 * 3600;
    },
  });
  await expect(page.getByTestId("money-as-of")).toContainText("Numbers as of");
  await expect(page.getByTestId("backing-amount")).toBeVisible();
});

test("a server that cannot be read says so, offers to try again, and still shows what the person holds", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "unreadable", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const { relay } = await openMoney(page, w, project, {
    account: w.who.backer,
    numbersDown: true,
  });
  await expect(page.getByText("The numbers could not be read")).toBeVisible();
  await expect(page.getByTestId("holding-shares")).toBeVisible({
    timeout: 20_000,
  });
  // The server comes back; Try again reads it.
  relay.setClosingSockets(false);
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByTestId("money-pot")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("backing-amount")).toBeVisible();
});

test("a project the server has not read yet says so and still lets a holder see and take out their Shares", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "noreading", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await openMoney(page, w, project, {
    account: w.who.backer,
    skipRecord: true,
  });
  await expect(page.getByTestId("money-none")).toContainText(
    "The server has not read this project's money yet",
  );
  await expect(page.getByTestId("chain-only-shares")).toBeVisible();
  await expect(page.getByTestId("holding-take-out")).toBeVisible({
    timeout: 20_000,
  });
});

test("the play-money notice is on the Money tab, on every sheet that moves money, and on You", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "playmoney", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 60n);
  // Some days pass and the team checks in: the allowance box has something in it, so its Draw is offered.
  await passTime(1000);
  await checkIn(w, project);
  // The founder's wallet: it runs the project, so the allowance and the Team's sheets are there too.
  await openMoney(page, w, project, { account: w.who.founder });
  await expect(page.getByTestId("play-money")).toContainText(NOTICE);
  const sheets: [string, string, string][] = [
    ["faucet-open", "faucet-sheet", "faucet"],
    ["backing-review", "back-sheet", "back"],
    ["allowance-draw", "draw-sheet", "draw"],
    ["allowance-rate-open", "rate-sheet", "rate"],
    ["allowance-door", "door-sheet", "door"],
  ];
  for (const [opener, sheet, name] of sheets) {
    if (opener === "backing-review") {
      await page.getByTestId("backing-amount").fill("5");
    }
    await page.getByTestId(opener).click();
    const open = page.getByTestId(sheet);
    await expect(open, `the ${name} sheet opens`).toBeVisible();
    await expect(
      open.getByTestId("sheet-play-money"),
      `the ${name} sheet says play money`,
    ).toContainText(NOTICE);
    await page.keyboard.press("Escape");
    await expect(open).toBeHidden();
  }
  // A holder's Take out sheet.
  const holder = await page.context().newPage();
  await openMoney(holder, w, project, { account: w.who.second });
  await holder.getByTestId("holding-take-out").click();
  await expect(
    holder.getByTestId("takeout-sheet").getByTestId("sheet-play-money"),
  ).toContainText(NOTICE);
  await holder.keyboard.press("Escape");
  // You: the person's Shares across projects.
  await holder.goto("/you");
  await expect(holder.getByTestId("your-shares-list")).toBeVisible({
    timeout: 20_000,
  });
  await expect(holder.getByTestId("your-shares-list")).toContainText(
    "play money",
  );
  // The page address of the project, to be sure the route used above is the project's.
  expect(pageOf("playmoney")).toContain("/p/playmoney");
});
