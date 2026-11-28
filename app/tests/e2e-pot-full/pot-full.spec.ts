import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { decodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { PLAY_DOLLAR_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import { addRevenueCalls } from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call, passTime, rpc } from "../anvil/rpc";
import { walletOf } from "../anvil/pot-chain";
import {
  backFor,
  giveDollars,
  launchedProject,
} from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import {
  check,
  checkAgainstContracts,
  helperJobs,
  dollarsAsPageSays,
  dollarsInASentence,
  NOT_RUNNABLE,
  type NumbersJson,
  newestRecord,
  ok,
  plus,
  query,
  RUN,
  same,
  secretKeyOf,
  sharesAsPageSays,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(NOT_RUNNABLE !== null, NOT_RUNNABLE ?? "");

/**
 * Step 1 of the join-and-leave design, all three parts joined up (`scripts/pot-full-loop.sh`): the real server with its chain
 * reader on a local chain, the contracts of `contracts/pot`, and the app's own build in Chromium. One journey, in the order
 * a project lives it:
 *
 *   a founder starts a project in the app and puts it on the chain; a first backer puts play money in; a stranger opens the
 *   project page and sees the numbers the server published; gets play dollars and Backs in two presses; the page shows the new
 *   Shares and what taking out now would give, and the server's numbers move once it has read the block; the founder checks
 *   in from This week and draws from the allowance; outside money arrives; the backer Takes out in two presses; the server's
 *   helper collects the platform's fee with nobody pressing; and every number on the page equals the record the server signed,
 *   which equals the contracts' own views at the record's block.
 *
 * The wallet in each browser is a real account on the local chain (the app's own test provider; no key anywhere). The chain
 * keeps producing a block a second, as a real one does, so the server can read what it must.
 */

const DOLLAR = 1_000_000n;
const LEGAL_LINE =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";

const read = (to: string, data: string) => call(to, data);

/** The project's page on its Money tab, freshly loaded. */
async function openMoney(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("project-money")).toBeVisible();
}

async function text(page: Page, id: string): Promise<string> {
  return ((await page.getByTestId(id).textContent()) ?? "").trim();
}

/** Parse "1,234.56" or "0.010058" (the page's dollars) into a number for a tolerance check. */
const asNumber = (words: string): number =>
  Number(words.replace(/[^0-9.]/g, ""));

/**
 * The page's numbers against the record it was built from. The Money tab is opened fresh and the newest record is read before
 * and after: when the server signed nothing in between, the page can only have shown that record, and every figure on the page
 * must be that record's, worded as the page words it. Tries again when the server signed a new record meanwhile.
 */
async function pageShowsTheRecord(
  page: Page,
  link: string,
  key: string,
  what: string,
  atLeast?: (numbers: NumbersJson) => boolean,
): Promise<NumbersJson> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await newestRecord(key);
    await openMoney(page, link);
    const pot = await text(page, "money-pot");
    const share = await text(page, "money-share-value");
    const after = await newestRecord(key);
    if (!before || !after || before.event.id !== after.event.id) continue;
    if (atLeast && !atLeast(after.content)) {
      await page.waitForTimeout(1000);
      continue;
    }
    const n = after.content;
    // The rest of what the Money tab says about the money is the same record's, in the page's words.
    const perDay =
      (BigInt(n.money.pot) * BigInt(n.allowance.ratePpm)) / 1_000_000n;
    const allowanceLine = await text(page, "money-allowance");
    check(
      allowanceLine.includes(
        `${(n.allowance.ratePpm / 10_000).toFixed(2)}% of the project's money a day`,
      ) &&
        allowanceLine.includes(
          `(about ${dollarsInASentence(perDay)} dollars today)`,
        ) &&
        allowanceLine.includes(
          `It holds ${dollarsInASentence(BigInt(n.allowance.box))} dollars now.`,
        ),
      `${what}: the allowance line is the record's rate, daily amount and box ("${allowanceLine.slice(0, 120)}")`,
    );
    const backers = BigInt(n.shares.backers);
    const teamCounted = BigInt(n.shares.teamCounted);
    same(
      await text(page, "money-team-part").then(
        (t) => /gets (\d+)%/.exec(t)?.[1],
      ),
      String((teamCounted * 100n) / (backers + teamCounted)),
      `${what}: the Team's part is the record's`,
    );
    same(
      await text(page, "money-state"),
      n.quiet.state === "active" ? "Open" : n.quiet.state,
      `${what}: where it stands is the record's`,
    );
    same(
      pot,
      dollarsAsPageSays(BigInt(n.money.pot)),
      `${what}: the page's money is the record's pot`,
    );
    same(
      share,
      dollarsAsPageSays(BigInt(n.value.leaveValue)),
      `${what}: what one Share gives if taken out now is the record's`,
    );
    return n;
  }
  throw new Error(
    `${what}: the page and the server's newest record never stood still together`,
  );
}

test("a project from its start to a Take out: the page, the server and the contracts agree at every step", async ({
  browser,
}) => {
  test.setTimeout(540_000);
  const w = await worldOnThisChain();
  const [firstBacker, backer, payer] = [
    w.who.member,
    w.who.backer,
    w.who.second,
  ];
  const platform = w.who.admin;
  const stopMiner = startMiner();
  let projectKey = "";
  const pages: Page[] = [];
  const shot = async (page: Page, name: string) => {
    if (!RUN.shots) return;
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${RUN.shots}/${name}.png` });
  };
  try {
    // ── the world answers ─────────────────────────────────────────────────────────────────────────────────────────
    const info = (await (
      await fetch(`${RUN.relay}/`, {
        headers: { accept: "application/nostr+json" },
      })
    ).json()) as { investing?: boolean; self?: string };
    same(info.investing, true, "the server says it offers investing");
    check(
      /^[0-9a-f]{64}$/.test(info.self ?? ""),
      "the server names its own key",
    );

    // ── a founder starts a project in the app and puts it on the chain ───────────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    const founderWallet = await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const name = `Lantern ${NAME_TAG}`;
    await founder.goto("/start");
    await founder.getByTestId("start-name").fill(name);
    await founder
      .getByTestId("start-goal")
      .fill("Solar lamps that ten night-market stalls use.");
    await founder
      .getByTestId("start-how")
      .fill("Ten stalls light up with them.");
    await founder.getByTestId("start-submit").click();
    await expect(founder.getByTestId("project-name")).toHaveText(name);
    const link = new URL(founder.url()).pathname;
    const ref = /^\/p\/(.+)-([0-9a-f]{16})$/.exec(link);
    if (!ref) throw new Error(`not a project link: ${link}`);
    const projectId = ref[1];
    const founderKey = await secretKeyOf(founder);
    const founderPub = getPublicKey(founderKey);
    ok(`the founder started "${name}" in the app (${link})`);

    // ── the founder opens it to backers from the project's page: one card, one sheet, one signature ─────────────────
    const launch = new PressCounter();
    await expect(founder.getByTestId("launch-card")).toBeVisible({
      timeout: 20_000,
    });
    await expect(founder.getByTestId("launch-play-money")).toContainText(
      "play money",
    );
    await launch.press(founder.getByTestId("launch-open"), "Launch");
    await expect(founder.getByTestId("launch-sheet")).toBeVisible();
    await expect(founder.getByTestId("launch-rate")).toHaveValue("0.10");
    await expect(founder.getByTestId("launch-pool")).toHaveValue("10,000,000");
    await shot(founder, "00-launch-sheet");
    await launch.press(
      founder.getByTestId("sheet-confirm"),
      "Launch the project",
    );
    await expect(founder.getByTestId("launch-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      launch.presses,
      2,
      "launching took two presses (Launch, then the sheet's press)",
    );
    same(founderWallet.prompts, 1, "launching asked the wallet once");
    const project = await launchedProject(w, projectId, founderPub);
    projectKey = project.key;
    ok(
      `the founder launched it on the chain from the app (key ${project.key.slice(0, 10)}…); the app named the launch in the project's record`,
    );
    // The page is tied to the launch and, until the server has read the project, shows no figure (never a zero).
    await expect(founder.getByTestId("launch-card")).toHaveCount(0);

    const first = await waitForRecord(
      project.key,
      "the project is known",
      () => true,
    );
    same(first.content.version, 2, "the server publishes record version 2");
    same(
      first.content.playMoney,
      true,
      "the server's record says this is play money",
    );
    same(
      first.content.contracts.treasury,
      project.treasury,
      "the record names the project's Treasury",
    );
    same(
      first.content.founder,
      w.who.founder,
      "the record names the founder's account",
    );
    same(
      first.event.pubkey,
      info.self ?? "",
      "the record is signed by the server's own key",
    );

    // ── a first backer puts money in (outside the browser) ───────────────────────────────────────────────────────
    const firstBackerShares = await backFor(w, project, firstBacker, 50n);
    check(
      firstBackerShares > 0n,
      "a first backer put in 50 play dollars and got Shares",
    );
    const afterFirstBacker = await waitForRecord(
      project.key,
      "the first backer's money is in",
      (n) => n.totals.joined === "50000000",
    );
    same(
      afterFirstBacker.content.money.paidIn,
      "49000000",
      "the server read it: 49 play dollars paid in (2% to the platform)",
    );

    // ── a stranger opens the project page ────────────────────────────────────────────────────────────────────────
    const stranger = await phone(browser);
    pages.push(stranger);
    await stranger.goto(link);
    await expect(stranger.getByTestId("project-name")).toHaveText(name);
    const seen = await pageShowsTheRecord(
      stranger,
      link,
      project.key,
      "a stranger signed out",
    );
    same(
      seen.totals.joined,
      "50000000",
      "the stranger sees the numbers the server published (after the first backer)",
    );
    await expect(stranger.getByTestId("play-money")).toContainText(
      "play money",
    );
    ok("the page says in plain words the dollars are play money");
    await expect(stranger.getByTestId("ownership")).toHaveText(LEGAL_LINE);
    ok("the legal line is on the page word for word");
    await expect(
      stranger.getByText("This can go up or down. It is not a return.").first(),
    ).toBeVisible();
    ok('the page says "This can go up or down. It is not a return."');
    await shot(stranger, "01-stranger-money-tab");

    // ── the stranger gets a wallet with play dollars and Backs ────────────────────────────────────────────────────
    const wallet = await installAnvilWallet(stranger, backer);
    await openMoney(stranger, link);
    const faucet = new PressCounter();
    await faucet.press(stranger.getByTestId("faucet-open"), "Get play dollars");
    await expect(stranger.getByTestId("faucet-open")).toBeHidden({
      timeout: 30_000,
    });
    same(
      faucet.presses,
      PLAN_V2_BUDGETS.faucet.presses,
      "getting play dollars took one press",
    );
    const faucetAmount = await reads.balanceOf(read, project.dollar, backer);
    same(
      faucetAmount,
      1000n * DOLLAR,
      "the faucet gave 1,000 play dollars on the chain",
    );
    await expect(stranger.getByTestId("holding-dollars")).toHaveText("1,000", {
      timeout: 20_000,
    });
    ok("the page shows the 1,000 play dollars");
    same(wallet.prompts, 1, "getting play dollars asked the wallet once");

    const back = new PressCounter();
    await back.type(
      stranger.getByTestId("backing-amount"),
      "100",
      "How many dollars?",
    );
    await back.press(stranger.getByTestId("backing-review"), "Back");
    await expect(stranger.getByTestId("back-sheet")).toBeVisible();
    await expect(stranger.getByTestId("back-shares")).toContainText("Shares");
    const sheetShares = await text(stranger, "back-shares");
    const sheetNow = await text(stranger, "back-now");
    await shot(stranger, "02-back-sheet");
    const backPressedAt = Date.now();
    await back.press(
      stranger.getByTestId("sheet-confirm"),
      "Back with 100 dollars",
    );
    await expect(stranger.getByTestId("back-sheet")).toBeHidden({
      timeout: 30_000,
    });
    const backBlock = Number.parseInt(await rpc<string>("eth_blockNumber"), 16);
    same(
      back.presses,
      PLAN_V2_BUDGETS.back.presses,
      "Back took two presses (Back, then the sheet's press)",
    );
    same(
      back.fields,
      PLAN_V2_BUDGETS.back.fields,
      "Back took one box typed in",
    );
    same(wallet.prompts, 2, "Back asked the wallet once (one signature)");
    same(
      wallet.sent.length,
      2,
      "the wallet sent the faucet call and one Back call",
    );
    same(
      decodeCall(PLAY_DOLLAR_ABI, wallet.sent[1].data)?.name ?? "",
      "transferAndCall",
      "the Back is one transferAndCall on the play dollar",
    );
    same(
      wallet.sent[1].to.toLowerCase(),
      project.dollar,
      "the Back went to the play dollar",
    );
    console.log(`MEASURED ${back.summary("Back (real server, real chain)")}`);

    // The new Shares and the take-out value, from the chain, at once.
    const backerShares = await reads.balanceOf(read, project.shares, backer);
    check(backerShares > 0n, "the backer holds Shares on the chain");
    await openMoney(stranger, link);
    await expect(stranger.getByTestId("holding-shares")).toHaveText(
      `${sharesAsPageSays(backerShares)} Shares`,
      { timeout: 20_000 },
    );
    ok(
      `the page shows the new Shares: ${sharesAsPageSays(backerShares)}, the chain's own balance`,
    );
    same(
      sheetShares,
      `${sharesAsPageSays(backerShares)} Shares`,
      "the Back sheet's Shares are the Shares that landed",
    );
    const cashWords = await text(stranger, "holding-cash");
    const quoteNow = await reads.quoteTakeOut(
      read,
      project.treasury,
      backer,
      backerShares,
    );
    const pageCash = asNumber(cashWords);
    const chainCash = Number(quoteNow.cashNow) / 1e6;
    check(
      Math.abs(pageCash - chainCash) <= chainCash * 0.005,
      `the page's take-out value (${cashWords}) is the chain's quote (${chainCash}) to within the guard`,
    );
    check(
      asNumber(sheetNow) > 0,
      `the Back sheet showed what taking out now would give (${sheetNow})`,
    );

    // The server reads the block; the page's money moves with it.
    const afterBack = await waitForRecord(
      project.key,
      "the second backer's money is in",
      (n) => n.totals.joined === "150000000" && n.asOf.block >= backBlock,
    );
    same(
      afterBack.content.money.paidIn,
      "147000000",
      "the server read the block: 147 play dollars paid in",
    );
    ok(
      `the server's numbers moved ${((Date.now() - backPressedAt) / 1000).toFixed(1)} s after the Back was pressed (a block a second, two blocks to be final, a pass a second)`,
    );
    check(
      afterBack.content.holders.some(
        (h) => h.account === backer && BigInt(h.shares) === backerShares,
      ),
      "the server's list of holders has the backer with exactly the chain's Shares",
    );
    await pageShowsTheRecord(
      stranger,
      link,
      project.key,
      "after the Back",
      (n) => n.totals.joined === "150000000",
    );
    await shot(stranger, "03-after-back");

    // ── the founder checks in from This week ──────────────────────────────────────────────────────────────────────
    const checkIn = async (words: string, again: boolean) => {
      await founder.goto("/week");
      const card = founder
        .getByTestId("week-project")
        .filter({ hasText: name });
      await expect(card).toBeVisible();
      if (again) {
        await card.getByTestId("week-check-in-only").click();
      } else {
        await card.getByTestId("week-open").click();
        await founder.getByTestId("weekly-text").fill(words);
        await founder.getByTestId("weekly-post").click();
      }
    };
    await checkIn(
      "Lit the first ten lamps and handed them to the stalls.",
      false,
    );
    await expect(founder.getByTestId("toast")).toBeVisible({ timeout: 30_000 });
    const checked1 = await waitForRecord(
      project.key,
      "the founder has checked in with a record",
      (n) => n.clock.lastRecordHash !== null,
    );
    ok(
      `the founder's check-in from This week reached the chain and the server read it (block ${checked1.content.asOf.block})`,
    );
    // The check-in points at the week's update the founder just posted: the server holds that record, signed by the founder.
    const pointedAt = checked1.content.clock.lastRecordHash ?? "";
    const [update] = await query({ ids: [pointedAt.replace(/^0x/, "")] });
    same(
      update?.pubkey,
      founderPub,
      "the check-in names the founder's own weekly update, which the server holds",
    );

    // Two days pass on the chain; the allowance flows into the box; the founder checks in again and draws.
    await passTime(2 * 86_400);
    await checkIn("", true);
    const checked2 = await waitForRecord(
      project.key,
      "the allowance box holds money",
      (n) =>
        BigInt(n.allowance.box) > 200_000n &&
        n.asOf.time > checked1.content.asOf.time + 86_400,
    );
    ok(
      `two days later the server's record shows the allowance box at ${dollarsAsPageSays(BigInt(checked2.content.allowance.box))} play dollars`,
    );
    await openMoney(founder, link);
    await expect(founder.getByTestId("allowance-section")).toBeVisible();
    await founder.getByTestId("allowance-draw").click();
    await expect(founder.getByTestId("draw-sheet")).toBeVisible();
    await founder.getByTestId("draw-to").fill(w.who.founder);
    await founder.getByTestId("draw-amount").fill("0.10");
    const dollarsBefore = await reads.balanceOf(
      read,
      project.dollar,
      w.who.founder,
    );
    await founder.getByTestId("sheet-confirm").click();
    await expect(founder.getByTestId("draw-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      (await reads.balanceOf(read, project.dollar, w.who.founder)) -
        dollarsBefore,
      100_000n,
      "the founder drew 0.10 play dollars from the allowance box and received it",
    );
    const afterDraw = await waitForRecord(
      project.key,
      "the draw is in the totals",
      (n) => n.totals.drawn === "100000",
    );
    ok(`the server read the draw (block ${afterDraw.content.asOf.block})`);

    // ── outside money arrives ─────────────────────────────────────────────────────────────────────────────────────
    await giveDollars(w, payer);
    await walletOf(payer).sendCalls(
      addRevenueCalls({
        dollar: project.dollar,
        treasury: project.treasury,
        amount: 200n * DOLLAR,
      }),
      31337,
    );
    const outside = await waitForRecord(
      project.key,
      "the outside money is counted",
      (n) => n.totals.outside === "200000000" && BigInt(n.money.arriving) > 0n,
    );
    ok(
      `outside money arrived: the server shows ${dollarsAsPageSays(BigInt(outside.content.money.arriving))} play dollars still arriving`,
    );
    await passTime(86_400); // a day later part of it has arrived, as the rule spreads it over a week

    // ── the backer Takes out ──────────────────────────────────────────────────────────────────────────────────────
    await openMoney(stranger, link);
    const takeOut = new PressCounter();
    await expect(stranger.getByTestId("holding-take-out")).toBeVisible({
      timeout: 20_000,
    });
    await takeOut.press(stranger.getByTestId("holding-take-out"), "Take out");
    await expect(stranger.getByTestId("takeout-sheet")).toBeVisible();
    await expect(stranger.getByTestId("takeout-cash")).toContainText("dollars");
    const sheetCash = await text(stranger, "takeout-cash");
    await expect(stranger.getByTestId("takeout-arriving")).toBeVisible();
    ok(
      "the Take out sheet says outside money is still arriving and stays for the people who stay",
    );
    await shot(stranger, "04-take-out-sheet");
    const dollarsBeforeOut = await reads.balanceOf(
      read,
      project.dollar,
      backer,
    );
    const promptsBefore = wallet.prompts;
    await takeOut.press(stranger.getByTestId("sheet-confirm"), "Take out all");
    await expect(stranger.getByTestId("takeout-sheet")).toBeHidden({
      timeout: 30_000,
    });
    const received =
      (await reads.balanceOf(read, project.dollar, backer)) - dollarsBeforeOut;
    same(
      takeOut.presses,
      PLAN_V2_BUDGETS.takeMoneyBack.presses,
      "Take out took two presses (Take out, then the sheet's press)",
    );
    same(
      wallet.prompts - promptsBefore,
      1,
      "Take out asked the wallet once (one signature)",
    );
    check(
      received > 0n,
      `the backer was paid ${dollarsAsPageSays(received)} play dollars`,
    );
    check(
      Math.abs(asNumber(sheetCash) - Number(received) / 1e6) <=
        (Number(received) / 1e6) * 0.005,
      `the sheet said "${sheetCash}" and the chain paid ${dollarsAsPageSays(received)}, within the guard`,
    );
    same(
      await reads.balanceOf(read, project.shares, backer),
      0n,
      "the backer holds no Shares after taking out",
    );
    console.log(
      `MEASURED ${takeOut.summary("Take out (real server, real chain)")}`,
    );
    await expect(stranger.getByTestId("holding-take-out")).toBeHidden({
      timeout: 20_000,
    });
    ok("the page no longer offers the backer a Take out: no Shares held");

    // ── the server's helper collects the platform's fee, with nobody pressing (once a week) ──────────────────────
    // The helper's first collection came when the first backer's fee was owed; the next is due a week later.
    let paid = 0n;
    for (let i = 0; i < 120 && paid === 0n; i += 1) {
      paid = await reads.balanceOf(read, project.dollar, platform);
      if (paid === 0n) await new Promise((r) => setTimeout(r, 1000));
    }
    check(
      paid >= 1_000_000n,
      `the server's helper collected the platform's fee with nobody pressing (${dollarsAsPageSays(paid)} play dollars so far)`,
    );

    // ── the last record of the journey: the page, the record and the contracts ────────────────────────────────────
    const tookOutIn = (n: NumbersJson) =>
      n.totals.tookOut === received.toString() && n.asOf.block > backBlock;
    const done = await waitForRecord(
      project.key,
      "the take-out is in",
      tookOutIn,
    );
    ok(
      `the server signed a record with the take-out at block ${done.content.asOf.block}`,
    );
    const final = await pageShowsTheRecord(
      stranger,
      link,
      project.key,
      "the backer's page at the end",
      tookOutIn,
    );
    await shot(stranger, "05-the-end");
    const founderSees = await pageShowsTheRecord(
      founder,
      link,
      project.key,
      "the founder's page at the end",
      tookOutIn,
    );
    same(
      founderSees.asOf.block,
      final.asOf.block,
      "both browsers show the same record",
    );
    const expected = {
      joined: "150000000",
      fees: "3000000",
      drawn: "100000",
      outside: "200000000",
      tookOut: received.toString(),
      holders: [firstBacker],
      notHolders: [backer],
    };
    plus(
      checkAgainstContracts(final, expected),
      `field-by-field checks of the record against the contracts' own views at block ${final.asOf.block}`,
    );
    same(
      BigInt(final.shares.backers),
      firstBackerShares,
      "the Shares left on the project are exactly the first backer's",
    );

    // ── a week later the helper collects the rest, and settles the outside money that has all arrived ────────────
    await passTime(8 * 86_400);
    let allPaid = 0n;
    for (let i = 0; i < 120 && allPaid < 3_000_000n; i += 1) {
      allPaid = await reads.balanceOf(read, project.dollar, platform);
      if (allPaid < 3_000_000n) await new Promise((r) => setTimeout(r, 1000));
    }
    same(
      allPaid,
      3_000_000n,
      "a week later the helper collected the rest: the platform holds all 3 play dollars of fees",
    );
    const weekLater = await waitForRecord(
      project.key,
      "the fee is collected and the outside money has all arrived",
      (n) =>
        n.money.feesOwed === "0" &&
        n.money.arriving === "0" &&
        n.asOf.time > final.asOf.time + 7 * 86_400,
    );
    const later = await pageShowsTheRecord(
      stranger,
      link,
      project.key,
      "the page a week later",
      (n) => n.money.feesOwed === "0" && n.money.arriving === "0",
    );
    same(
      later.asOf.block >= weekLater.content.asOf.block,
      true,
      "the page shows a record from after the week",
    );
    plus(
      checkAgainstContracts(later, expected),
      `field-by-field checks of the record a week later, against the contracts at block ${later.asOf.block}`,
    );
    // What the helper may do is two calls; it checked in for nobody and nothing failed.
    let jobs = helperJobs();
    for (let i = 0; i < 60 && !jobs.every((j) => j.state === "done"); i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      jobs = helperJobs();
    }
    check(
      jobs.length >= 2 &&
        jobs.every((j) => j.state === "done" || j.state === "sent"),
      `the helper's jobs all went through: ${jobs.map((j) => `${j.call}:${j.state}`).join(", ")}`,
    );
    check(
      jobs.every(
        (j) =>
          j.call === "treasury.collectFees" || j.call === "treasury.settle",
      ),
      "the helper sent only the two calls it may: collect the fee and settle",
    );
    const helperNonce = Number.parseInt(
      await rpc<string>("eth_getTransactionCount", [RUN.helper, "latest"]),
      16,
    );
    same(
      helperNonce,
      jobs.length,
      "every transaction from the helper's address is one of those jobs",
    );
  } catch (error) {
    // What each browser showed when it failed, for whoever reads the run.
    for (const [i, page] of pages.entries()) {
      const words = await page
        .locator("body")
        .innerText()
        .catch(() => "(the page is gone)");
      console.log(`--- browser ${i} at ${page.url()}\n${words.slice(0, 1200)}`);
      if (RUN.shots)
        await page
          .screenshot({ path: `${RUN.shots}/failed-${i}.png` })
          .catch(() => undefined);
    }
    if (RUN.shots && projectKey) {
      const last = await newestRecord(projectKey).catch(() => null);
      if (last)
        writeFileSync(
          `${RUN.shots}/failed-record.json`,
          JSON.stringify({ event: last.event }, null, 1),
        );
    }
    throw error;
  } finally {
    stopMiner();
    for (const page of pages) await page.context().close();
  }
  // What the server stored of the founder's record is still the one the app wrote (nothing the journey did replaced it).
  const records = await query({ kinds: [37001] });
  check(records.length >= 1, "the server still holds the project's record");
});
