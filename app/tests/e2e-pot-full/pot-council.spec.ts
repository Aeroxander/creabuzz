import { expect, type Page, test } from "@playwright/test";
import {
  COUNCIL_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { councilSeats } from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { walletOf } from "../anvil/pot-chain";
import { call, passTime, rpc, word } from "../anvil/rpc";
import { CHECK_IN_NO_RECORD } from "../../src/features/money/runner";
import { topicOf } from "../../../packages/creaton-core/src/launchpad/work.ts";
import { backFor, giveDollars } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import {
  atNarrowPhone,
  backInApp,
  check,
  dollarsAsPageSays,
  NOT_RUNNABLE,
  ok,
  same,
  startAndLaunch,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(
  NOT_RUNNABLE !== null || process.env.POT_WORLD_KIND !== "council",
  NOT_RUNNABLE ??
    "run by scripts/pot-full-loop.sh in the world deployed with HOLDER_PAUSE=1 COUNCIL=1",
);

/**
 * Milestone 9's Council, joined up (`scripts/pot-full-loop.sh`, a world deployed with `HOLDER_PAUSE=1 COUNCIL=1`): the real
 * server with its chain reader, a local chain, and the app's own build in Chromium. One journey:
 *
 *   a founder starts a project and launches it; two backers back it; the runner offers the seat to a Council of five
 *   accounts and anyone makes the Council; the Treasury's runner and the Launcher's kind say it; the record says the runner is
 *   a Council of five with three needed, and the app's Money tab shows the Council section with its five seats, "3 of them must
 *   agree", the next election and the plan's last line; **the seat presses the app's own runner presses** — "Check in only"
 *   and, once the box has filled, "Draw from the box" — each going out as a proposal the record counts and the seat holder's
 *   page lists ("Posts and votes are public."); two more seats agree to each on the chain, the call runs and the record's
 *   waiting count returns to zero; the section fits a 360 x 640 screen.
 *
 * The chain moves by seconds in this world, not days, so the page's own clock is left alone and no record reads as old. A
 * replace vote end to end is the ballot world that follows.
 */

const SALT = `0x${"11".repeat(32)}` as const;
const addressWord = (value: bigint) =>
  `0x${value.toString(16).padStart(40, "0")}`;

interface Numbers {
  runner: { kind?: string; address: string; isPair: boolean };
  allowance: { box: string };
  council: {
    contract: string;
    seats: { account: string | null; seatedAt: number | null }[];
    needed: number;
    nextElection: number | null;
    waiting: { count: number };
  } | null;
}

const numbersOf = (content: unknown) => content as Numbers;

test("a founder hands the seat to a Council, the app shows it, a seat proposes, the holder page shows it, three seats agree and the record keeps up", async ({
  browser,
}) => {
  test.setTimeout(900_000);
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

    // ── two backers back it, so the project has holders ──────────────────────────────────────────────────────────────
    await backFor(w, project, w.who.backer, 50n);
    await backFor(w, project, w.who.second, 30n);
    ok("two backers backed the project from the chain");

    // ── the runner offers the seat to five accounts; anyone makes the Council ────────────────────────────────────────
    const members = [
      w.who.backer,
      w.who.second,
      w.who.member,
      w.who.stranger,
      w.who.helper,
    ].map((a) => a.toLowerCase() as string);
    const predicted = await read(
      w.chain.launcher,
      pot.councilAddressData({ key: project.key, members, salt: SALT }),
    );
    const council = `0x${predicted.slice(-40)}`;
    await walletOf(w.who.founder).sendCalls(
      [
        pot.handOverCall({
          treasury: project.treasury,
          next: council,
          founderLeaves: false,
        }),
      ],
      31337,
    );
    await walletOf(w.who.admin).sendCalls(
      [
        pot.makeCouncilCall({
          launcher: w.chain.launcher,
          key: project.key,
          members,
          salt: SALT,
        }),
      ],
      31337,
    );
    same(
      addressWord(
        await word(project.treasury, encodeCall(TREASURY_ABI, "runner", [])),
      ),
      council,
      "the Treasury's runner is the Council the offer named",
    );
    const chainSeats = await councilSeats(read, council);
    check(
      chainSeats.every(
        (seat, i) => (seat.account ?? "").toLowerCase() === members[i],
      ),
      "the Council's own seats are the five accounts the offer named",
    );
    ok(
      "the runner offered the seat to five accounts and anyone made the Council",
    );

    // ── the record and the app agree: a Council runner, five seats, three needed ─────────────────────────────────────
    const withCouncil = await waitForRecord(
      project.key,
      "the record says the runner is a Council of five",
      (n) => {
        const c = numbersOf(n).council;
        return (
          numbersOf(n).runner.kind === "council" &&
          c !== null &&
          c.seats.filter((s) => s.account !== null).length === 5 &&
          c.needed === 3
        );
      },
    );
    const c0 = numbersOf(withCouncil.content).council;
    same(
      c0?.contract,
      council,
      "the record's Council is the Treasury's runner",
    );
    same(c0?.needed, 3, "three of the five must agree");
    for (let i = 0; i < 5; i += 1) {
      same(
        (c0?.seats[i]?.account ?? "").toLowerCase(),
        members[i],
        `the record's seat ${i + 1} is the account the Council holds`,
      );
    }
    check(
      (c0?.nextElection ?? 0) > 0,
      "the record names when two seats next come up",
    );

    // ── the app's Money tab shows the Council section ────────────────────────────────────────────────────────────────
    await founder.goto(`${link}?tab=money`);
    await expect(founder.getByTestId("council-section")).toBeVisible({
      timeout: 60_000,
    });
    await expect(founder.getByTestId("council-seat")).toHaveCount(5);
    await expect(founder.getByTestId("council-summary")).toContainText(
      "3 of them must agree",
    );
    await expect(founder.getByTestId("council-last-line")).toContainText(
      "A Council is five accounts",
    );
    await expect(founder.getByTestId("council-next-election")).toBeVisible();
    ok(
      "the Money tab shows the Council section: five seats, three of them must agree, the next election and the plan's last line",
    );

    // ── one seat presses "Check in only" on the Money tab: the press goes out as a proposal to the other seats ──────
    // The weekly check-in press lives on the Money tab too, on purpose: after a hand-over the runner did not start the
    // project, so the This-week page lists nothing for them and this is the only way back. A seat's press asks the other
    // seats, and both the line under it and the note after say so.
    const nonce = await word(council, encodeCall(COUNCIL_ABI, "nonce", []));
    const seatA = await phone(browser);
    pages.push(seatA);
    await installAnvilWallet(seatA, members[0] as string);
    await newPerson(seatA, `Ana ${NAME_TAG}`);
    // A seat's page reads its seat from the account's *linked* wallet: back a little in the app, which links it.
    await giveDollars(w, members[0] as string);
    await seatA.goto(link);
    await backInApp(seatA, 5);
    await seatA.goto(`${link}?tab=money`);
    await expect(seatA.getByTestId("council-section")).toBeVisible({
      timeout: 60_000,
    });
    await expect(seatA.getByTestId("allowance-check-in")).toBeVisible({
      timeout: 60_000,
    });
    await seatA.getByTestId("allowance-check-in").click();
    await expect(seatA.getByTestId("toast")).toContainText(
      "Asked. It runs when enough seats agree.",
      { timeout: 60_000 },
    );
    const waiting = await waitForRecord(
      project.key,
      "the record counts the waiting action",
      (n) => (numbersOf(n).council?.waiting.count ?? 0) >= 1,
      180,
    );
    same(
      numbersOf(waiting.content).council?.waiting.count,
      1,
      "one action waits for the other seats",
    );
    await seatA.reload();
    await expect(seatA.getByTestId("council-waiting-row")).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(
      seatA.getByTestId("council-waiting-row").first(),
    ).toContainText("Check in for the project");
    await expect(seatA.getByTestId("council-waiting-public")).toContainText(
      "Posts and votes are public.",
    );
    ok(
      "a seat pressed Check in only on the Money tab: the press went out as a proposal the other seats must agree to, the record counts it, and the seat's page lists it",
    );

    // ── two more seats agree: the call runs, and the record's waiting count goes back to zero ──────────────────────
    // The app pressed check-in carrying no week's words (32 zero bytes): the seats agree to that exact call.
    const checkIn = pot.checkInCall(project.treasury, CHECK_IN_NO_RECORD);
    for (const seat of [members[1], members[2]] as string[]) {
      await walletOf(seat).sendCalls(
        [pot.councilAgreeCall(council, checkIn.to, checkIn.data, nonce)],
        31337,
      );
    }
    const ran = await waitForRecord(
      project.key,
      "the record's waiting count is back to zero",
      (n) => (numbersOf(n).council?.waiting.count ?? 0) === 0,
      180,
    );
    same(numbersOf(ran.content).council?.waiting.count, 0, "nothing waits");
    // The third agreement ran the call: the Council wrote `Executed` and the record deleted the waiting action.
    const executed = (await rpc<unknown[]>("eth_getLogs", [
      {
        address: council,
        fromBlock: "0x0",
        toBlock: "latest",
        topics: [topicOf("Executed(bytes32,address)")],
      },
    ])) as unknown[];
    check(
      executed.length >= 1,
      "three of the five agreed and the Council ran the check-in (an Executed log is on the chain)",
    );
    ok(
      "two more seats agreed, the action ran, and the record's waiting count returned to zero",
    );

    // ── the box fills, and the seat presses Draw from the box: the runner's presses are the seat's too ──────────────
    await passTime(2 * 86_400);
    const boxFilled = await waitForRecord(
      project.key,
      "the allowance box holds money",
      (n) => BigInt(n.allowance.box) > 250_000n,
      180,
    );
    ok(
      `two days later the allowance box holds ${dollarsAsPageSays(BigInt(boxFilled.content.allowance.box))} play dollars`,
    );
    const drawNonce = await word(council, encodeCall(COUNCIL_ABI, "nonce", []));
    await seatA.goto(`${link}?tab=money`);
    await expect(seatA.getByTestId("allowance-draw")).toBeEnabled({
      timeout: 60_000,
    });
    await seatA.getByTestId("allowance-draw").click();
    await expect(seatA.getByTestId("draw-sheet")).toBeVisible();
    await seatA.getByTestId("draw-to").fill(members[3] as string);
    await seatA.getByTestId("draw-amount").fill("0.25");
    await expect(seatA.getByTestId("runner-ask")).toContainText(
      "This asks the other seats to agree",
    );
    await seatA.getByTestId("sheet-confirm").click();
    await expect(seatA.getByTestId("toast")).toContainText(
      "Asked. It runs when enough seats agree.",
      { timeout: 60_000 },
    );
    const drew = await waitForRecord(
      project.key,
      "the record counts the draw proposal",
      (n) => (numbersOf(n).council?.waiting.count ?? 0) >= 1,
      180,
    );
    same(numbersOf(drew.content).council?.waiting.count, 1, "the draw waits");
    await seatA.reload();
    await expect(
      seatA.getByTestId("council-waiting-row").first(),
    ).toContainText("Draw 0.25 dollars from the allowance", {
      timeout: 120_000,
    });
    ok(
      "a seat pressed Draw from the box in the app: it went out as a proposal, and its row says what it draws",
    );
    // The proposal is byte-for-byte the call the seats agree to: the app and the chain never disagree about a step.
    const draw = pot.drawCall({
      treasury: project.treasury,
      to: (members[3] as string).toLowerCase(),
      amount: 250_000n,
    });
    for (const seat of [members[1], members[2]] as string[]) {
      await walletOf(seat).sendCalls(
        [pot.councilAgreeCall(council, draw.to, draw.data, drawNonce)],
        31337,
      );
    }
    await waitForRecord(
      project.key,
      "the draw ran",
      (n) => (numbersOf(n).council?.waiting.count ?? 0) === 0,
      180,
    );
    ok("two more seats agreed and the draw ran");

    // ── 360 x 640: the section does not scroll sideways ──────────────────────────────────────────────────────────────
    await atNarrowPhone(founder, "the Council section", ["council-section"]);
    ok(
      "the Council section fits a 360 x 640 screen without scrolling sideways",
    );
  } finally {
    stopMiner();
    for (const page of pages) await page.close().catch(() => {});
  }
});
