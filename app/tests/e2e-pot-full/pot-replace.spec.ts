import { expect, type Page, test } from "@playwright/test";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import {
  balanceOf,
  pauseGateOf,
} from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { walletOf } from "../anvil/pot-chain";
import { call, passTime } from "../anvil/rpc";
import { backFor, giveDollars } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import {
  atNarrowPhone,
  backInApp,
  check,
  NOT_RUNNABLE,
  ok,
  same,
  startAndLaunch,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(
  NOT_RUNNABLE !== null || process.env.POT_WORLD_KIND !== "replace",
  NOT_RUNNABLE ??
    "run by scripts/pot-full-loop.sh in a world deployed with HOLDER_PAUSE=1 COUNCIL=1",
);

/**
 * Milestone 9's replace vote, joined up (`scripts/pot-full-loop.sh`, a world deployed with `HOLDER_PAUSE=1 COUNCIL=1`): the real
 * server with its chain reader, a local chain, and the app's own build in Chromium. One journey:
 *
 *   a founder starts a project and launches it; two backers back it and park enough Shares from the chain for a vote to open;
 *   one of them opens a replace vote with a list of five accounts; the record says the ballot is standing and the app's card
 *   says what is being decided; the chain's clock moves past the stand window and a parked holder casts a vote in the app; the
 *   second one votes on the chain, so the floor is met; the clock passes the vote's end and the card shows the planned change
 *   from the frozen tallies with nobody having recorded the result; a holder takes out during the wait and the planned change
 *   stands; the wait passes and anyone carries the result out; the record's runner becomes the new Council and the card is gone.
 *
 * The chain's clock moves by days here, so each page is put on the chain's time (`syncClock`) before it is read.
 */

const LIST = `0x${"5d".repeat(32)}`;
const DAY = 86_400;

interface Numbers {
  runner: { kind?: string; address: string };
  council: { contract: string; seats: { account: string | null }[] } | null;
  vote: {
    open: {
      id: string;
      kind: string;
      phase: string;
      cast: string;
      result: { outcome: string } | null;
    } | null;
  } | null;
}

const numbersOf = (content: unknown) => content as Numbers;

test("a replace vote opens, the card follows it through voting and the wait, a holder takes out, the result is carried out and a new Council runs the project", async ({
  browser,
}) => {
  test.setTimeout(1_200_000);
  const w = await worldOnThisChain();
  const stopMiner = startMiner();
  const read = (to: string, data: string) => call(to, data);
  const pages: Page[] = [];
  try {
    // ── the founder starts and launches the project ──────────────────────────────────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const name = `Lantern ${NAME_TAG}`;
    const { link, project } = await startAndLaunch(w, founder, name);
    ok(`the founder started "${name}" and launched it (${link})`);

    // ── two backers back it and park, so a vote can open ─────────────────────────────────────────────────────────────
    await backFor(w, project, w.who.backer, 100n);
    await backFor(w, project, w.who.second, 100n);
    const pause = await pauseGateOf(read, project.treasury);
    if (pause === null) throw new Error("the project has no pause contract");
    const heldByBacker = await balanceOf(read, project.shares, w.who.backer);
    const heldBySecond = await balanceOf(read, project.shares, w.who.second);
    await walletOf(w.who.backer).sendCalls(
      pot.parkCalls({
        shares: project.shares,
        pause,
        amount: (heldByBacker * 3n) / 4n,
      }),
      31337,
    );
    await walletOf(w.who.second).sendCalls(
      pot.parkCalls({
        shares: project.shares,
        pause,
        amount: (heldBySecond * 3n) / 4n,
      }),
      31337,
    );
    ok(
      "two backers backed the project and parked three quarters of their Shares",
    );

    // ── one of them opens a replace vote with a list of five accounts ────────────────────────────────────────────────
    const list = [
      w.who.admin,
      w.who.member,
      w.who.stranger,
      w.who.helper,
      w.who.founder,
    ].map((a) => a.toLowerCase() as string);
    await walletOf(w.who.backer).sendCalls(
      [
        pot.openReplaceCall({
          vote: pause,
          members: list,
          recordHash: LIST,
        }),
      ],
      31337,
    );
    const standing = await waitForRecord(
      project.key,
      "the record carries the ballot standing",
      (n) => {
        const v = numbersOf(n).vote;
        return v?.open?.kind === "replace" && v.open.phase === "standing";
      },
      180,
    );
    const ballotId = BigInt(numbersOf(standing.content).vote?.open?.id ?? "0");
    check(ballotId >= 1n, "the ballot has an id");
    const voterPage = await phone(browser);
    pages.push(voterPage);
    await installAnvilWallet(voterPage, w.who.backer);
    await newPerson(voterPage, `Bo ${NAME_TAG}`);
    await giveDollars(w, w.who.backer);
    await voterPage.goto(link);
    await backInApp(voterPage, 1); // links the wallet to the account; a back after the snapshot counts for no vote
    await voterPage.goto(`${link}?tab=money`);
    await expect(voterPage.getByTestId("vote-card")).toBeVisible({
      timeout: 120_000,
    });
    await expect(voterPage.getByTestId("vote-card")).toContainText(
      "A vote on who runs this project",
    );
    await expect(voterPage.getByTestId("vote-intro")).toContainText(
      "Holders are choosing between keeping things as they are",
    );
    await expect(voterPage.getByTestId("vote-state-standing")).toBeVisible();
    ok(
      "the vote opened, the record says it is standing, and the card says what is being decided",
    );

    // ── the stand window passes; both parked holders vote on the chain, and the floor is met ─────────────────────────
    await passTime(DAY + 120);
    await waitForRecord(
      project.key,
      "the record says the ballot is voting",
      (n) => numbersOf(n).vote?.open?.phase === "voting",
      240,
    );
    ok("the stand window passed and the record moved the ballot to voting");
    await walletOf(w.who.backer).sendCalls([pot.castVoteCall(pause, 1)], 31337);
    await walletOf(w.who.second).sendCalls([pot.castVoteCall(pause, 1)], 31337);
    const cast = await waitForRecord(
      project.key,
      "the record counts the votes cast",
      (n) => BigInt(numbersOf(n).vote?.open?.cast ?? "0") > 0n,
      240,
    );
    check(
      BigInt(numbersOf(cast.content).vote?.open?.cast ?? "0") > 0n,
      "the record counts the cast weight",
    );
    ok(
      "both parked holders voted for the list on the chain and the record counts it",
    );

    // ── the vote's end: the record derives the result with nobody pressing finish, and the wait keeps it ─────────────
    await passTime(3 * DAY + 120);
    const ended = await waitForRecord(
      project.key,
      "the record shows the planned change from the frozen tallies",
      (n) => {
        const open = numbersOf(n).vote?.open;
        return open?.phase === "waiting" && open.result?.outcome === "moved";
      },
      300,
    );
    same(
      numbersOf(ended.content).vote?.open?.result?.outcome,
      "moved",
      "the frozen tallies say the seat moves, without a recorded finish",
    );
    ok(
      "the vote ended and the record derives 'moved' from the frozen tallies with nobody pressing finish",
    );

    // ── a holder takes out during the wait: the planned change stands ────────────────────────────────────────────────
    const secondHeld = await balanceOf(read, project.shares, w.who.second);
    const secondParked = (heldBySecond * 3n) / 4n;
    void secondHeld;
    await walletOf(w.who.second).sendCalls(
      pot.takeOutWithParkedCalls({
        treasury: project.treasury,
        pause,
        walletShares: secondHeld - secondParked,
        parkedShares: secondParked,
        minCash: 0n,
        to: w.who.second,
      }),
      31337,
    );
    const stillMoved = await waitForRecord(
      project.key,
      "the record still shows the planned change after a take out",
      (n) =>
        numbersOf(n).vote?.open?.phase === "waiting" &&
        numbersOf(n).vote?.open?.result?.outcome === "moved",
      300,
    );
    same(
      numbersOf(stillMoved.content).vote?.open?.result?.outcome,
      "moved",
      "a take out during the wait does not undo the planned change",
    );
    ok("a holder took out during the wait and the planned change still stands");

    // ── the wait passes and anyone carries the result out: a new Council runs the project ───────────────────────────
    await passTime(16.5 * DAY + 300);
    await walletOf(w.who.admin).sendCalls(
      [pot.carryOutCall(pause, ballotId)],
      31337,
    );
    const council = await waitForRecord(
      project.key,
      "the record's runner is the Council the vote chose",
      (n) => numbersOf(n).runner.kind === "council",
      300,
    );
    const c = numbersOf(council.content).council;
    check(c !== null, "the record carries the new Council");
    const seatAccount = (i: number) =>
      (c?.seats[i]?.account ?? "").toLowerCase();
    check(
      list.every((who, i) => seatAccount(i) === who),
      "the new Council's five seats are the list the ballot chose",
    );
    ok(
      "the wait passed, anyone carried the result out, and the record's runner is the Council of the winning list",
    );

    // ── a fresh page reads the result: no vote card, the new Council in the Money tab ───────────────────────────────
    const reader = await phone(browser);
    pages.push(reader);
    await newPerson(reader, `Ry ${NAME_TAG}`);
    await reader.goto(`${link}?tab=money`);
    await expect(reader.getByTestId("council-section")).toBeVisible({
      timeout: 120_000,
    });
    await expect(reader.getByTestId("council-seat")).toHaveCount(5);
    await expect(reader.getByTestId("vote-card")).toHaveCount(0, {
      timeout: 120_000,
    });
    ok(
      "a fresh page shows the new Council and no vote card, because the result was carried out",
    );

    // ── 360 x 640: the section and the project page do not scroll sideways ──────────────────────────────────────────
    await atNarrowPhone(founder, "the project page", ["project-page"]);
    ok("the project page fits a 360 x 640 screen without scrolling sideways");
  } finally {
    stopMiner();
    for (const page of pages) await page.close().catch(() => {});
  }
});
