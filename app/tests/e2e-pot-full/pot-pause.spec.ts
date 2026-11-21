import { expect, type Page, test } from "@playwright/test";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { potProblem } from "../../src/features/money/pot-copy";
import { launchSentence } from "../../src/features/pause/pause-words";
import { walletOf } from "../anvil/pot-chain";
import { call, passTime } from "../anvil/rpc";
import { backFor, giveDollars } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import {
  backInApp,
  check,
  checkAgainstContracts,
  atNarrowPhone,
  NOT_RUNNABLE,
  ok,
  plus,
  same,
  startAndLaunch,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(
  NOT_RUNNABLE !== null || process.env.POT_WORLD_KIND !== "pause",
  NOT_RUNNABLE ??
    "run by scripts/pot-full-loop.sh in the world deployed with HOLDER_PAUSE=1",
);

/**
 * Step 4's holder pause, joined up (`scripts/pot-full-loop.sh`, a world deployed with HOLDER_PAUSE=1): the real server with its
 * chain reader, a local chain, and the app's own build in Chromium. One journey:
 *
 *   a founder starts a project and is told, before signing, that holders can pause the team's spending; one backer holds half
 *   of the Shares (put in from the chain) and two holders back in the app; the first parks all of theirs (a quarter of the
 *   Shares: under the line, nothing is armed), the second parks half of theirs (past the line: a warning day starts, and the team
 *   is told); the chain's clock moves past the day; the record says the team's spending is paused, the card says so, the team's
 *   Draw is off with the reason beside it and a draw and a new plan are refused by the chain and read in the app's own words;
 *   the first holder takes out everything they hold, parked Shares included, with ONE press on the sheet (un-park, then leave);
 *   the pause ends (parked Shares are under the line again) and the team's Draw comes back; and the record equals the contracts'
 *   own views at each step.
 *
 * The page's own clock is left alone on purpose: the server dates a record by its own clock, so a page set to the chain's clock,
 * days ahead, would read every record as old.
 */

const LINE_WORDS = "a third";

const holdingText = (page: Page) =>
  page.getByTestId("holding-shares").textContent();

test("holders park past the line, the warning day passes, the team's draw is refused, a holder takes out parked Shares in one press and the pause ends", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const w = await worldOnThisChain();
  const stopMiner = startMiner();
  const read = (to: string, data: string) => call(to, data);
  const pages: Page[] = [];
  try {
    // ── a founder starts a project and is told, before signing, what the pause is ───────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    const founderWallet = await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const name = `Lantern ${NAME_TAG}`;
    const started = await startAndLaunch(
      w,
      founder,
      name,
      undefined,
      undefined,
      async (page) => {
        await expect(page.getByTestId("launch-pause")).toHaveText(
          launchSentence(3),
        );
        ok(
          "the launch sheet says, before the founder signs, that holders can pause the team's spending and that it cannot be turned off",
        );
        // The sheet still has its banner, the line and the legal words, once.
        await expect(page.getByTestId("sheet-banner")).toHaveCount(1);
      },
    );
    const { link, project } = started;
    ok(`the founder started "${name}" and launched it on the chain (${link})`);
    void founderWallet;

    // ── three holders: a big one from the chain (who never parks) and two who back in the app ──────────────────────────
    const [holderA, holderC] = [w.who.member, w.who.second];
    await backFor(w, project, w.who.backer, 50n);
    await giveDollars(w, holderA);
    await giveDollars(w, holderC);
    const pageA = await phone(browser);
    pages.push(pageA);
    await installAnvilWallet(pageA, holderA);
    await newPerson(pageA, `Ana ${NAME_TAG}`);
    await pageA.goto(link);
    await backInApp(pageA, 25);
    const pageC = await phone(browser);
    pages.push(pageC);
    await installAnvilWallet(pageC, holderC);
    await newPerson(pageC, `Cy ${NAME_TAG}`);
    await pageC.goto(link);
    await backInApp(pageC, 25);
    const first = await waitForRecord(
      project.key,
      "the record carries the project's pause with nothing parked",
      (n) =>
        n.holders.length >= 3 &&
        (n as unknown as { pause: { parkedTotal: string } | null }).pause
          ?.parkedTotal === "0",
    );
    const pauseOf = (n: unknown) =>
      (
        n as {
          pause: {
            contract: string;
            parkedTotal: string;
            line: string;
            lineDivisor: number;
            armedAt: number | null;
            pausesFrom: number | null;
            paused: boolean;
            since: number | null;
            parkerCount: number;
          } | null;
        }
      ).pause;
    check(
      pauseOf(first.content)?.lineDivisor === 3 &&
        pauseOf(first.content)?.paused === false,
      "the record names the stop: a third is the line, nothing parked, not paused",
    );
    // The treasury names the pause contract the record names.
    const gate = await reads.pauseGateOf(read, project.treasury);
    same(
      gate,
      pauseOf(first.content)?.contract,
      "the Treasury names the pause the record names",
    );

    // ── the first holder parks everything they hold: under the line, nothing is armed ───────────────────────────────────
    await pageA.goto(`${link}?tab=money`);
    const heldA = await reads.balanceOf(read, project.shares, holderA);
    await expect(pageA.getByTestId("pause-card")).toBeVisible({
      timeout: 60_000,
    });
    await expect(pageA.getByTestId("pause-state-under")).toContainText(
      "A third is needed.",
    );
    ok(
      "the project page's card says holders can pause the team's spending, how much is parked and that a third is needed",
    );
    await atNarrowPhone(pageA, "the project's pause card and Your Shares", [
      "pause-card",
      "holding-shares",
      "park-open",
    ]);
    await pageA.getByTestId("park-open").click();
    await expect(pageA.getByTestId("park-sheet")).toBeVisible();
    await expect(pageA.getByTestId("park-first")).toContainText(
      "Parked Shares count toward pausing the team's spending. They stay yours: take them back or take them out any day.",
    );
    await expect(pageA.getByTestId("park-account-line")).toHaveText(
      "Your wallet is asked twice: first to let the project hold them, then to park.",
    );
    await expect(pageA.getByTestId("park-summary")).toContainText(
      "At a third, the team's allowance and new task plans pause one day later.",
    );
    ok(
      "the Park sheet names the line and the wait, and says the wallet is asked twice (no promise of one press)",
    );
    await pageA.getByTestId("sheet-confirm").click();
    await expect(pageA.getByTestId("park-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      await reads.parkedOf(read, gate as string, holderA),
      heldA,
      "everything the first holder had is parked",
    );
    same(
      await reads.balanceOf(read, project.shares, holderA),
      0n,
      "and none is left in the wallet",
    );
    await expect(pageA.getByTestId("holding-parked")).toBeVisible({
      timeout: 30_000,
    });
    same(
      (await holdingText(pageA)) ?? "",
      `${Number(heldA / 10n ** 18n).toLocaleString("en-US")} Shares`,
      "parked Shares are still held: the holding line says so",
    );
    const underLine = await waitForRecord(
      project.key,
      "the record counts the first holder's parked Shares",
      (n) => pauseOf(n)?.parkedTotal === heldA.toString(),
    );
    check(
      pauseOf(underLine.content)?.armedAt === null &&
        pauseOf(underLine.content)?.paused === false &&
        pauseOf(underLine.content)?.parkerCount === 1,
      "a quarter parked is under the line: nothing is armed, one account has Shares parked, and the record names no one",
    );
    plus(
      checkAgainstContracts(underLine.content, {}, true),
      `field-by-field checks of the record against the contracts, with Shares parked, at block ${underLine.content.asOf.block}`,
    );

    // ── the second holder parks half of theirs: past the line, a warning day starts ─────────────────────────────────────
    await pageC.goto(`${link}?tab=money`);
    await pageC.getByTestId("park-open").click();
    await expect(pageC.getByTestId("park-sheet")).toBeVisible();
    await pageC.getByTestId("park-portion-half").check();
    await expect(pageC.getByTestId("park-summary")).toContainText(
      "You park 1,2",
      { timeout: 20_000 },
    );
    await pageC.getByTestId("sheet-confirm").click();
    await expect(pageC.getByTestId("park-sheet")).toBeHidden({
      timeout: 30_000,
    });
    const armed = await waitForRecord(
      project.key,
      "the line is reached and a warning day is running",
      (n) => pauseOf(n)?.armedAt !== null && pauseOf(n)?.paused === false,
    );
    check(
      pauseOf(armed.content)?.pausesFrom ===
        (pauseOf(armed.content)?.armedAt ?? 0) + 86_400 &&
        BigInt(pauseOf(armed.content)?.parkedTotal ?? "0") >=
          BigInt(pauseOf(armed.content)?.line ?? "1"),
      "the pause starts exactly one day after the line was first reached, and parked Shares are at the line",
    );
    await pageA.reload();
    await expect(pageA.getByTestId("pause-state-armed")).toContainText(
      "A third is parked. The team's allowance and new task plans pause on",
      { timeout: 60_000 },
    );
    ok(
      "the card says a third is parked and when the team's allowance and new plans pause if it stays there, and never says stopped",
    );
    // The team sees the warning, and Draw still works until the day is over.
    await founder.goto(`${link}?tab=money`);
    await expect(founder.getByTestId("team-pause-armed")).toContainText(
      "Holders have parked a third of all Shares.",
      { timeout: 60_000 },
    );
    await expect(founder.getByTestId("allowance-draw")).toBeEnabled();
    ok(
      "the team is told holders have parked a third; Draw is still on until the day is over",
    );

    // ── the day passes: the record, the card and the team's presses all say it is paused ────────────────────────────────
    await passTime(86_400 + 120);
    const paused = await waitForRecord(
      project.key,
      "the pause is on",
      (n) => pauseOf(n)?.paused === true,
      120,
    );
    same(
      pauseOf(paused.content)?.since,
      pauseOf(paused.content)?.pausesFrom,
      "the record's 'paused since' is the day the warning ended",
    );
    plus(
      checkAgainstContracts(paused.content, {}, true),
      `field-by-field checks of the record against the contracts, with the pause on, at block ${paused.content.asOf.block}`,
    );
    await pageA.reload();
    await expect(pageA.getByTestId("pause-state-paused")).toContainText(
      "Paused since",
      { timeout: 60_000 },
    );
    await expect(pageA.getByTestId("pause-state-paused")).toContainText(
      "Everyone can still take their money out.",
    );
    ok(
      "the card says paused since when, that tasks already planned go on and that everyone can still take their money out",
    );
    await founder.reload();
    await expect(founder.getByTestId("team-pause-paused")).toContainText(
      `until fewer than ${LINE_WORDS} of Shares are parked`,
      { timeout: 60_000 },
    );
    await expect(founder.getByTestId("allowance-draw")).toBeDisabled();
    ok(
      "the team's Draw is off while paused, with the reason beside it in the team's words",
    );
    // The chain refuses a draw and a new plan; the app reads each refusal in its own words.
    const refusal = async (
      calls: pot.PotCall[],
      action: Parameters<typeof potProblem>[1],
    ) => {
      const error = await walletOf(w.who.founder)
        .sendCalls(calls, 31337)
        .then(
          () => null,
          (e: unknown) => e,
        );
      if (error === null) throw new Error("the chain did not refuse");
      return potProblem(error, action);
    };
    const refused =
      "The team's spending is paused by holders. Try again when parked Shares fall below a third.";
    same(
      await refusal(
        [
          pot.drawCall({
            treasury: project.treasury,
            to: w.who.stranger,
            amount: 100_000n,
          }),
        ],
        "draw",
      ),
      refused,
      "a draw during the pause is refused and the app says why",
    );
    same(
      await refusal(
        [
          pot.announceTaskCall({
            treasury: project.treasury,
            what: `0x${"a1".repeat(32)}`,
            payee: w.who.stranger,
            maxDollars: 2_000_000n,
            shareBps: 100,
          }),
        ],
        "plan-task",
      ),
      refused,
      "a new task plan during the pause is refused and the app says why",
    );

    // ── the first holder takes out everything they hold, parked Shares included: ONE press ──────────────────────────────
    await pageA.goto(`${link}?tab=money`);
    await expect(pageA.getByTestId("holding-take-out")).toBeVisible({
      timeout: 30_000,
    });
    const dollarsBefore = await reads.balanceOf(read, project.dollar, holderA);
    await pageA.getByTestId("holding-take-out").click();
    await expect(pageA.getByTestId("takeout-sheet")).toBeVisible();
    await expect(pageA.getByTestId("takeout-held")).toContainText("(");
    await expect(pageA.getByTestId("takeout-held")).toContainText("parked)");
    await expect(pageA.getByTestId("takeout-unparks")).toHaveText(
      "Taking out takes your parked Shares back first, in the same press. Your wallet is asked twice.",
    );
    await expect(pageA.getByTestId("takeout-cash")).toBeVisible();
    ok(
      "the Take out sheet says the parked Shares come back first, in the same press, and asks nothing the pause could hold back",
    );
    await pageA.getByTestId("sheet-confirm").click();
    await expect(pageA.getByTestId("takeout-sheet")).toBeHidden({
      timeout: 40_000,
    });
    same(
      await reads.balanceOf(read, project.shares, holderA),
      0n,
      "the first holder holds no Shares in the wallet after one press",
    );
    same(
      await reads.parkedOf(read, gate as string, holderA),
      0n,
      "and none are parked: the parked Shares were taken back and taken out in that press",
    );
    check(
      (await reads.balanceOf(read, project.dollar, holderA)) > dollarsBefore,
      "the first holder was paid, with the pause on",
    );

    // ── the pause ends: parked Shares are under the line, the record says so and the team's Draw comes back ─────────────
    const ended = await waitForRecord(
      project.key,
      "the pause has ended",
      (n) => pauseOf(n)?.paused === false && pauseOf(n)?.armedAt === null,
      120,
    );
    check(
      BigInt(pauseOf(ended.content)?.parkedTotal ?? "0") <
        BigInt(pauseOf(ended.content)?.line ?? "0"),
      "parked Shares are under the line again, so the pause has ended and nothing is armed",
    );
    plus(
      checkAgainstContracts(ended.content, {}, true),
      `field-by-field checks of the record against the contracts, after the pause ended, at block ${ended.content.asOf.block}`,
    );
    await founder.reload();
    await expect(founder.getByTestId("allowance-draw")).toBeEnabled({
      timeout: 60_000,
    });
    await expect(founder.getByTestId("team-pause-paused")).toHaveCount(0);
    await walletOf(w.who.founder).sendCalls(
      [
        pot.drawCall({
          treasury: project.treasury,
          to: w.who.stranger,
          amount: 10_000n,
        }),
      ],
      31337,
    );
    ok("the team's Draw is back and a draw goes through");
    // The server never named a parker: the pause part of the record holds one address, the pause contract's own.
    const named = JSON.stringify(pauseOf(ended.content)).match(
      /0x[0-9a-f]{40}/g,
    );
    check(
      named?.length === 1 && named[0] === gate,
      "the pause part of the record names no one: its only address is the pause contract's",
    );
  } finally {
    stopMiner();
    for (const page of pages) await page.context().close();
  }
});
