import { expect, type Page, test } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { signatureOf } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { TASK_BOOK_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import { topicOf } from "../../../packages/creaton-core/src/launchpad/work.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { timeText } from "../../src/features/money/numbers";
import { percentOfBps } from "../../src/features/money/pot-copy-tasks";
import {
  acceptRecord,
  cancelRecord,
  type ProjectTask,
} from "../../src/features/tasks/task-record";
import { call, passTime, rpc } from "../anvil/rpc";
import { walletOf } from "../anvil/pot-chain";
import { backFor, checkIn, launchedProject } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import {
  check,
  checkAgainstContracts,
  dollarsInASentence,
  helperJobs,
  NOT_RUNNABLE,
  newestRecord,
  ok,
  plus,
  query,
  RUN,
  same,
  secretKeyOf,
  startMiner,
  type TaskRowJson,
  tryPublish,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(NOT_RUNNABLE !== null, NOT_RUNNABLE ?? "");

/**
 * Step 2 of the join-and-leave design, joined up (`scripts/pot-full-loop.sh`): the task queue and exit notes with the real
 * server (its chain reader follows each project's task book, its relay rules tie a team's task record to its plan) on a local
 * chain, and the app's own build in Chromium. One journey, in the order a task lives it:
 *
 *   a founder starts a project in the app and launches it; two holders back it; the founder posts a task and a worker takes it
 *   (the team's own records, through the real server); the team plans the pay from the Tasks tab; a holder on another profile
 *   reads the two lines on the project page and the news on You; the chain's clock moves past the notice; the worker sets the
 *   money aside; a holder takes out and is left a note; the team pays part of it and the app saves, on the team's record, the
 *   payment that paid it (the server ties the record to the payment on the network); the holder claims; a second task that
 *   nobody settles runs out and the server's helper returns it. At each step the record the server signed is compared with the
 *   contracts' own views at the record's block, field by field.
 *
 * Every wallet is a real account on the local chain (the app's own test provider; no key anywhere). Nothing is mocked.
 */

const DOLLAR = 1_000_000n;
const read = (to: string, data: string) => call(to, data);
const WHAT = `Translate the guide ${NAME_TAG}`;
/** The task pays 6 dollars; the team pays 4 of them. */
const TASK_USD = 6;
const PART_USD = "4";

/** Dollars the way a sentence says them: "1 dollar", "4 dollars". */
const dollarsPhrase = (raw: bigint): string =>
  raw === DOLLAR ? "1 dollar" : `${dollarsInASentence(raw)} dollars`;

/** The task record's row for `serial` in the newest record. */
const rowOf = (
  n: { tasks?: { list: TaskRowJson[] } | null },
  serial: number,
): TaskRowJson | undefined => n.tasks?.list.find((r) => r.serial === serial);

/** What the chain says about task `serial` of `book`. */
async function onChain(book: string, serial: bigint) {
  const task = await reads.readTask(read, book, serial);
  if (!task) throw new Error(`the book has no task ${serial}`);
  return task;
}

/** The transaction that ended task `serial` and the second of its block, from the book's own log. */
async function resolvedAt(
  book: string,
  serial: bigint,
): Promise<{ tx: string; at: number }> {
  const item = TASK_BOOK_ABI.find(
    (i) => i.type === "event" && i.name === "TaskResolved",
  );
  if (!item) throw new Error("no TaskResolved event");
  const logs = await rpc<{ transactionHash: string; blockNumber: string }[]>(
    "eth_getLogs",
    [
      {
        address: book,
        fromBlock: "0x0",
        toBlock: "latest",
        topics: [
          topicOf(signatureOf(item)),
          `0x${serial.toString(16).padStart(64, "0")}`,
        ],
      },
    ],
  );
  const last = logs[logs.length - 1];
  if (!last) throw new Error(`task ${serial} has no TaskResolved log`);
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
    last.blockNumber,
    false,
  ]);
  return {
    tx: last.transactionHash.toLowerCase(),
    at: Number.parseInt(block.timestamp, 16),
  };
}

/** When each of the tasks `serials` ended, as the chain's own blocks say (the checker needs it to know which tasks the list holds). */
async function endedAt(
  book: string,
  serials: bigint[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const serial of serials)
    out[String(serial)] = (await resolvedAt(book, serial)).at;
  return out;
}

test("a task from its plan to its claim: the page, the server and the contracts agree at every step", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const w = await worldOnThisChain();
  const [holderA, holderB, workerAccount] = [
    w.who.member,
    w.who.backer,
    w.who.stranger,
  ];
  const stopMiner = startMiner();
  let projectKey = "";
  const pages: Page[] = [];
  const shot = async (page: Page, name: string) => {
    if (!RUN.shots) return;
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${RUN.shots}/tasks-${name}.png` });
  };
  try {
    // ── step 1: a founder starts a project in the app and launches it ────────────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    const founderWallet = await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const name = `Beacon ${NAME_TAG}`;
    await founder.goto("/start");
    await founder.getByTestId("start-name").fill(name);
    await founder
      .getByTestId("start-goal")
      .fill("A shared repair shop for night-market stalls.");
    await founder
      .getByTestId("start-how")
      .fill("Ten stalls bring their tools and share them.");
    await founder.getByTestId("start-submit").click();
    await expect(founder.getByTestId("project-name")).toHaveText(name);
    const link = new URL(founder.url()).pathname;
    const ref = /^\/p\/(.+)-([0-9a-f]{16})$/.exec(link);
    if (!ref) throw new Error(`not a project link: ${link}`);
    const projectId = ref[1];
    const founderPub = getPublicKey(await secretKeyOf(founder));
    await expect(founder.getByTestId("launch-card")).toBeVisible({
      timeout: 20_000,
    });
    await founder.getByTestId("launch-open").click();
    await expect(founder.getByTestId("launch-sheet")).toBeVisible();
    await founder.getByTestId("sheet-confirm").click();
    await expect(founder.getByTestId("launch-sheet")).toBeHidden({
      timeout: 30_000,
    });
    const project = await launchedProject(w, projectId, founderPub);
    projectKey = project.key;
    same(founderWallet.prompts, 1, "launching asked the wallet once");
    ok(`the founder started "${name}" and launched it on the chain (${link})`);

    // The server follows the project's task book from the launch: its record carries a `tasks` section with nothing in it yet.
    const first = await waitForRecord(
      project.key,
      "the project is known with its task book",
      (n) => Boolean(n.tasks),
    );
    const book = first.content.tasks?.book ?? "";
    same(
      book,
      (await reads.readBookOf(read, project.treasury)) ?? "",
      "the server found the project's task book (the Treasury's own)",
    );
    same(first.content.tasks?.nextSerial, 1, "no task has been planned yet");

    // ── step 2: two holders back it; the team checks in ──────────────────────────────────────────────────────────
    await backFor(w, project, holderA, 150n);
    await backFor(w, project, holderB, 150n);
    await checkIn(w, project);
    const backed = await waitForRecord(
      project.key,
      "both holders' money is in",
      (n) => n.totals.joined === "300000000",
    );
    ok(
      `two holders backed it with 150 play dollars each: the server's pot is ${dollarsInASentence(BigInt(backed.content.money.pot))}`,
    );

    // ── step 3: the founder posts a task in the app; a worker takes it ───────────────────────────────────────────
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    await founder.getByTestId("task-new").click();
    await founder.getByTestId("task-what").fill(WHAT);
    await founder.getByTestId("task-dollars").fill(String(TASK_USD));
    await founder.getByTestId("task-post").click();
    await expect(founder.getByTestId("task-card").first()).toContainText(WHAT, {
      timeout: 20_000,
    });
    const [taskRecord] = await query({
      kinds: [47003],
      "#a": [`37001:${founderPub}:${projectId}`],
      "#task-part": ["task"],
      limit: 1,
    });
    check(
      Boolean(taskRecord),
      "the founder's task record is on the server (its id is what a plan will name)",
    );
    const worker = await phone(browser);
    pages.push(worker);
    const workerWallet = await installAnvilWallet(worker, workerAccount);
    await newPerson(worker, `Wes ${NAME_TAG}`);
    await worker.goto(link);
    await worker.getByTestId("tab-tasks").click();
    await worker.getByTestId("task-take").click();
    await expect(worker.getByTestId("task-card").first())
      .toContainText("Hand the work in", { timeout: 20_000 })
      .catch(() => undefined);
    const takeSteps = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const steps = await query({
          kinds: [47003],
          "#e": [taskRecord.id],
          "#task-part": ["take"],
          limit: 5,
        });
        if (steps.length) return steps;
        await new Promise((r) => setTimeout(r, 500));
      }
      return [];
    })();
    check(
      takeSteps.length === 1 &&
        takeSteps[0].tags.some(
          (t) =>
            t[0] === "task-pay-to" &&
            t[1].toLowerCase() === workerAccount.toLowerCase(),
        ),
      "the worker took it, naming the wallet they will be paid at",
    );
    same(
      workerWallet.connects >= 1,
      true,
      "taking asked the worker's wallet to connect",
    );

    // ── step 4: the team plans the pay from the Tasks tab ────────────────────────────────────────────────────────
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    await expect(founder.getByTestId("door-plan")).toHaveText(
      `Plan the pay of ${TASK_USD} dollars`,
      { timeout: 30_000 },
    );
    const promptsBeforePlan = founderWallet.prompts;
    await founder.getByTestId("door-plan").click();
    await expect(founder.getByTestId("plan-sheet")).toBeVisible();
    await expect(founder.getByTestId("plan-pay-to")).toContainText(
      workerAccount,
      { ignoreCase: true, timeout: 20_000 },
    );
    await expect(founder.getByTestId("plan-max")).toContainText(
      `${TASK_USD} dollars`,
    );
    await expect(founder.getByTestId("sheet-play-money")).toContainText(
      "play money",
    );
    await shot(founder, "01-plan-sheet");
    await founder.getByTestId("sheet-confirm").click();
    await expect(founder.getByTestId("plan-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      founderWallet.prompts - promptsBeforePlan,
      1,
      "planning the pay asked the wallet once",
    );
    const planned = await onChain(book, 1n);
    same(planned.state, "announced", "the chain holds the plan");
    same(
      planned.what,
      `0x${taskRecord.id}`,
      "the plan names the team's task record",
    );
    same(
      planned.payee,
      workerAccount,
      "the plan names the wallet the worker gave",
    );
    same(
      planned.maxDollars,
      BigInt(TASK_USD) * DOLLAR,
      "the plan's most is the task's pay",
    );

    const afterPlan = await waitForRecord(
      project.key,
      "the server read the plan",
      (n) => rowOf(n, 1)?.state === "announced",
    );
    const planRow = rowOf(afterPlan.content, 1) as TaskRowJson;
    same(
      planRow.what,
      planned.what,
      "the server's row names the same task record",
    );
    same(
      planRow.noticeEnd,
      planned.noticeEnd,
      "the server's row has the chain's notice end",
    );
    same(
      BigInt(planRow.maxDollars),
      planned.maxDollars,
      "the server's row has the chain's most",
    );
    plus(
      checkAgainstContracts(afterPlan.content, {}, true),
      `field-by-field checks of the record against the contracts at block ${afterPlan.content.asOf.block} (a plan in its notice)`,
    );

    // ── step 5: a holder on another profile, and a stranger signed out, read the two lines ───────────────────────
    const viewer = await phone(browser);
    pages.push(viewer);
    await installAnvilWallet(viewer, holderB);
    await newPerson(viewer, `Hana ${NAME_TAG}`);
    await viewer.goto(link);
    const mostWords = dollarsInASentence(BigInt(planRow.maxDollars));
    const noticeDate = timeText(planRow.noticeEnd);
    const lines = async (page: Page, who: string) => {
      const strip = page.getByTestId("planned-strip").first();
      await expect(strip).toBeVisible({ timeout: 30_000 });
      await expect(strip.getByTestId("planned-line-1")).toHaveText(
        `The team plans to pay up to ${mostWords} dollars to Wes ${NAME_TAG} for “${WHAT}”, from ${noticeDate}.`,
      );
      await expect(strip.getByTestId("planned-line-2")).toContainText(
        `You can take your money out before then. ${mostWords} dollars is the most; it can be less if people take out first.`,
      );
      await expect(strip.getByTestId("strip-play-money")).toContainText(
        "play money",
      );
      ok(
        `${who} reads the two lines: who would get how much at most, from when, and that they can take out first`,
      );
    };
    await lines(viewer, "a holder on another profile");
    // What would be set aside today is the server's figure for the row, said as the page says it.
    await expect(
      viewer.getByTestId("planned-strip").first().getByTestId("planned-now"),
    ).toContainText(
      `${dollarsInASentence(BigInt(planRow.atMostNow ?? "0"))} dollars would be set aside today`,
    );
    ok(
      "the page says what would be set aside today: the server's own figure for the row",
    );
    // The holder's way out is in front of them: the strip's own press, named with the date.
    await expect(
      viewer
        .getByRole("button", { name: `Take out before ${noticeDate}` })
        .first(),
    ).toBeVisible();
    await shot(viewer, "02-holder-strip");
    const stranger = await phone(browser);
    pages.push(stranger);
    await stranger.goto(link);
    await lines(stranger, "a stranger signed out");

    // The news on You: one row for the plan, with the date money can first move and the way out.
    await viewer.goto("/you");
    const news = viewer.getByTestId("news-row").first();
    await expect(news).toBeVisible({ timeout: 30_000 });
    await expect(news.getByTestId("news-sentence")).toContainText(
      `${name}: the team plans to pay up to ${mostWords} dollars for “${WHAT}”, from ${noticeDate}. You can take your money out before then.`,
    );
    await expect(news.getByTestId("news-urgent")).toContainText(
      `You can take your money out before ${noticeDate}.`,
    );
    await expect(viewer.getByTestId("news-play-money")).toContainText(
      "play money",
    );
    ok(
      "the news on You tells the holder about the plan, with the date and the way out",
    );
    await shot(viewer, "03-holder-news");

    // ── step 6: the chain's clock moves past the notice; the worker hands work in and sets the money aside ───────
    await worker.goto(link);
    await worker.getByTestId("tab-tasks").click();
    await worker.getByTestId("task-hand-in").click();
    await worker
      .getByTestId("task-note")
      .fill("The guide is translated; the link is in the folder.");
    await worker.getByTestId("task-hand-in-send").click();
    await expect(worker.getByTestId("task-card").first())
      .toContainText("handed in", { ignoreCase: true, timeout: 20_000 })
      .catch(() => undefined);
    const noticeSecs = planned.noticeEnd - planned.announcedAt;
    await passTime(noticeSecs + 120);
    await checkIn(w, project);
    const afterNotice = await waitForRecord(
      project.key,
      "the server has read past the notice",
      (n) =>
        n.asOf.time >= planned.noticeEnd && rowOf(n, 1)?.state === "announced",
    );
    check(
      afterNotice.content.asOf.time >= planned.noticeEnd,
      "the server's record is from after the notice ended",
    );
    await worker.reload();
    await worker.getByTestId("tab-tasks").click();
    await expect(worker.getByTestId("take-open")).toHaveText(
      "Set the money aside",
      {
        timeout: 30_000,
      },
    );
    const promptsBeforeTake = workerWallet.prompts;
    await worker.getByTestId("take-open").click();
    await expect(worker.getByTestId("take-sheet")).toBeVisible();
    await expect(worker.getByTestId("take-guard")).toBeVisible();
    await expect(worker.getByTestId("sheet-play-money")).toContainText(
      "play money",
    );
    await shot(worker, "04-take-sheet");
    await worker.getByTestId("sheet-confirm").click();
    await expect(worker.getByTestId("take-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      workerWallet.prompts - promptsBeforeTake,
      1,
      "setting the money aside asked the wallet once",
    );
    const taken = await onChain(book, 1n);
    same(taken.state, "taken", "the chain holds the task as taken");
    same(
      taken.takenBy,
      workerAccount,
      "it was taken by the wallet the plan named",
    );
    same(
      taken.setAside,
      BigInt(TASK_USD) * DOLLAR,
      "the whole most was set aside (the sheet's guard held)",
    );
    const afterTake = await waitForRecord(
      project.key,
      "the server read the take",
      (n) => rowOf(n, 1)?.state === "taken",
    );
    same(
      rowOf(afterTake.content, 1)?.setAside,
      String(taken.setAside),
      "the server's row has the chain's money set aside",
    );
    same(
      afterTake.content.money.locked,
      String(taken.stayerClaim),
      "the project's money set aside for tasks is the stayers' claim on that task",
    );
    plus(
      checkAgainstContracts(afterTake.content, {}, true),
      `field-by-field checks of the record against the contracts at block ${afterTake.content.asOf.block} (a task taken)`,
    );

    // ── step 7: a holder takes out while the money is set aside and is left a note ───────────────────────────────
    const leaver = await phone(browser);
    pages.push(leaver);
    await installAnvilWallet(leaver, holderA);
    await newPerson(leaver, `Lee ${NAME_TAG}`);
    await leaver.goto(link);
    await leaver.getByTestId("tab-money").click();
    await expect(leaver.getByTestId("holding-take-out")).toBeVisible({
      timeout: 30_000,
    });
    const cashBefore = await reads.balanceOf(read, project.dollar, holderA);
    await leaver.getByTestId("holding-take-out").click();
    await expect(leaver.getByTestId("takeout-sheet")).toBeVisible();
    await expect(leaver.getByTestId("takeout-note")).toContainText(
      "is set aside for a task",
      {
        timeout: 20_000,
      },
    );
    await expect(leaver.getByTestId("takeout-where-to-claim")).toBeVisible();
    await shot(leaver, "05-take-out-sheet");
    await leaver.getByTestId("sheet-confirm").click();
    await expect(leaver.getByTestId("takeout-sheet")).toBeHidden({
      timeout: 30_000,
    });
    const cashIn =
      (await reads.balanceOf(read, project.dollar, holderA)) - cashBefore;
    check(
      cashIn > 0n,
      `the leaver's cash arrived at once: ${dollarsInASentence(cashIn)} play dollars`,
    );
    same(
      await reads.balanceOf(read, project.shares, holderA),
      0n,
      "the leaver holds no Shares any more",
    );
    const face = await reads.readNoteOf(read, book, 1n, holderA);
    check(
      face > 0n,
      `the leaver is owed a note on the task: ${dollarsInASentence(face)} play dollars at most`,
    );
    const afterLeave = await waitForRecord(
      project.key,
      "the server read the leaver's note",
      (n) => BigInt(rowOf(n, 1)?.noteFace ?? "0") === face,
    );
    const listed = rowOf(afterLeave.content, 1)?.notes?.holders.find(
      (h) => h.account === holderA.toLowerCase(),
    );
    same(
      listed?.face,
      String(face),
      "the server lists the leaver's note with the chain's own face",
    );
    same(
      listed?.claimable,
      "0",
      "and says nothing can be claimed while the task runs",
    );
    plus(
      checkAgainstContracts(afterLeave.content, {}, true),
      `field-by-field checks of the record against the contracts at block ${afterLeave.content.asOf.block} (a note written)`,
    );

    // The server ties the team's own record to the network: while the money is set aside, a team member's word that the task is
    // stopped is refused, in the server's own words, and nothing changes. (The record is signed by the founder's real key.)
    const founderSecret = await secretKeyOf(founder);
    const coordinate = `37001:${founderPub}:${projectId}`;
    const asTask = { id: taskRecord.id, author: founderPub } as ProjectTask;
    const stop = await tryPublish(
      finalizeEvent(
        cancelRecord(coordinate, asTask, "Stopping it."),
        founderSecret,
      ),
      founderSecret,
    );
    check(
      !stop.accepted &&
        stop.text.includes(
          "withdraw or send back the money on the network first",
        ),
      `a team record that stops a task whose money is set aside is refused: ${stop.text.slice(0, 160)}`,
    );

    // ── step 8: the team pays part of it; the app saves the payment on the team's record ─────────────────────────
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    await expect(founder.getByTestId("pay-open")).toHaveText(
      "Pay for the work",
      {
        timeout: 30_000,
      },
    );
    const workerBefore = await reads.balanceOf(
      read,
      project.dollar,
      workerAccount,
    );
    const promptsBeforePay = founderWallet.prompts;
    await founder.getByTestId("pay-open").click();
    await expect(founder.getByTestId("accept-sheet")).toBeVisible();
    await expect(founder.getByTestId("accept-pay-to")).toContainText(
      workerAccount,
      {
        ignoreCase: true,
        timeout: 20_000,
      },
    );
    await founder.getByTestId("accept-part").check();
    await founder.getByTestId("accept-amount").fill(PART_USD);
    await expect(founder.getByTestId("accept-left")).toBeVisible();
    await shot(founder, "06-pay-part");
    await founder.getByTestId("sheet-confirm").click();
    await expect(founder.getByTestId("accept-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      founderWallet.prompts - promptsBeforePay,
      1,
      "paying asked the wallet once",
    );
    const pay = BigInt(PART_USD) * DOLLAR;
    same(
      (await reads.balanceOf(read, project.dollar, workerAccount)) -
        workerBefore,
      pay,
      "the worker was paid exactly the part the team chose, on the chain",
    );
    const paid = await onChain(book, 1n);
    same(paid.state, "paid", "the chain holds the task as paid");
    same(
      paid.returned,
      paid.setAside - pay,
      "the rest went back to the project and to the people who took out",
    );
    const payTx = (await resolvedAt(book, 1n)).tx;
    const afterPay = await waitForRecord(
      project.key,
      "the server read the payment",
      (n) => rowOf(n, 1)?.state === "paid",
    );
    const paidRow = rowOf(afterPay.content, 1) as TaskRowJson;
    same(paidRow.pay, String(pay), "the server's row says what was paid");
    same(
      paidRow.resolvedTx,
      payTx,
      "the server's row names the transaction that paid",
    );
    same(
      afterPay.content.totals.paidToWorkers,
      String(pay),
      "the server's total paid to workers is that payment",
    );
    const evidence = (
      await query({ kinds: [47003], "#e": [taskRecord.id], limit: 50 })
    ).find((e) =>
      e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence"),
    );
    if (!evidence) throw new Error("the worker's hand-in is not on the server");
    const wrongTx = `0x${"ab".repeat(32)}`;
    const forged = await tryPublish(
      finalizeEvent(
        acceptRecord(coordinate, asTask, evidence.id, wrongTx),
        founderSecret,
      ),
      founderSecret,
    );
    check(
      !forged.accepted &&
        forged.text.includes("that is not the payment that paid this task"),
      `a team record that names another transaction as the payment is refused: ${forged.text.slice(0, 160)}`,
    );
    // The team's record names that payment. The app writes it as soon as the payment landed; the server answers "try again" until
    // it has read the payment itself, and then the card's own press saves it.
    const recordPaid = async () => {
      const steps = await query({
        kinds: [47003],
        "#e": [taskRecord.id],
        limit: 50,
      });
      return steps.filter((e) =>
        e.tags.some(
          (t) => t[0] === "task-paid" && t[1].toLowerCase() === payTx,
        ),
      );
    };
    let saved = await recordPaid();
    // The server answers "try again" until its reader has read the payment; which of the two ways the record got saved is said.
    const savedAtOnce = saved.length > 0;
    if (saved.length === 0) {
      await founder.goto(link);
      await founder.getByTestId("tab-tasks").click();
      const press = founder.getByTestId("save-paid-press");
      await expect(press).toBeVisible({ timeout: 30_000 });
      await shot(founder, "07-save-paid");
      await press.click();
      for (let i = 0; i < 40 && saved.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        saved = await recordPaid();
      }
    }
    ok(
      savedAtOnce
        ? "the app saved the payment on the team's record at once: the server had read it"
        : "the server had not read the payment yet and said so; the card's own press saved it afterwards, nothing was paid twice",
    );
    check(
      saved.length >= 1,
      "the team's record names the transaction that paid it, and the server took it",
    );
    plus(
      checkAgainstContracts(
        afterPay.content,
        {
          paidToWorkers: String(pay),
          endedAt: await endedAt(book, [1n]),
        },
        true,
      ),
      `field-by-field checks of the record against the contracts at block ${afterPay.content.asOf.block} (a task paid in part)`,
    );

    // ── step 9: the leaver claims what the network says the note pays ────────────────────────────────────────────
    const owed = await reads.readClaimable(read, book, 1n, holderA);
    check(
      owed > 0n,
      `the network says the note now pays ${dollarsInASentence(owed)} play dollars`,
    );
    await leaver.goto(link);
    await leaver.getByTestId("tab-money").click();
    const press = leaver.getByTestId("notes-claim");
    await expect(press).toBeVisible({ timeout: 30_000 });
    await expect(press).toHaveText(`Claim ${dollarsPhrase(owed)}`);
    const leaverBefore = await reads.balanceOf(read, project.dollar, holderA);
    await press.click();
    await expect(leaver.getByTestId("claim-sheet")).toBeVisible();
    await expect(leaver.getByTestId("claim-words")).toContainText(
      "The money goes to your account.",
    );
    await shot(leaver, "08-claim-sheet");
    await leaver.getByTestId("sheet-confirm").click();
    await expect(leaver.getByTestId("claim-sheet")).toBeHidden({
      timeout: 30_000,
    });
    same(
      (await reads.balanceOf(read, project.dollar, holderA)) - leaverBefore,
      owed,
      "the claim paid exactly what the network said",
    );
    same(
      await reads.readNoteOf(read, book, 1n, holderA),
      0n,
      "the note is spent",
    );
    const afterClaim = await waitForRecord(
      project.key,
      "the server read the claim",
      (n) => BigInt(n.totals.noteClaims) === owed,
    );
    plus(
      checkAgainstContracts(
        afterClaim.content,
        {
          paidToWorkers: String(pay),
          noteClaims: String(owed),
          endedAt: await endedAt(book, [1n]),
        },
        true,
      ),
      `field-by-field checks of the record against the contracts at block ${afterClaim.content.asOf.block} (a note claimed)`,
    );
    // The holder who stayed reads how the task ended: paid in part, and the rest went back (the server's figures, in the page's words).
    await viewer.goto("/you");
    await expect(
      viewer.getByTestId("news-row").filter({
        hasText: `was paid ${dollarsPhrase(pay)} of the ${dollarsPhrase(BigInt(paidRow.setAside))} set aside; the rest went back.`,
      }),
    ).toHaveCount(1, { timeout: 30_000 });
    ok(
      "the holder who stayed reads how the first task ended: paid in part, the rest went back",
    );
    // The team's own Tasks tab reads the same ending in the network's words, with the part that was paid and what went back.
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    await expect(
      founder
        .getByTestId("task-chain-state")
        .filter({ hasText: `Paid ${dollarsPhrase(pay)}.` }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      founder.getByTestId("task-chain-detail").filter({
        hasText: `Paid ${dollarsPhrase(pay)} of the ${dollarsPhrase(BigInt(paidRow.setAside))} set aside; the rest went back.`,
      }),
    ).toHaveCount(1);
    ok(
      "the team's Tasks tab reads the first task in the network's words: paid in part, the rest went back",
    );

    // ── step 10: a second task that nobody settles runs out; the server's helper returns it ──────────────────────
    await checkIn(w, project);
    const potNow = BigInt(
      (await newestRecord(project.key))?.content.money.pot ?? "0",
    );
    const share2 = Number((3n * DOLLAR * 11_000n + potNow - 1n) / potNow);
    const what2 = `0x${"c2".repeat(32)}`;
    await walletOf(w.who.founder).sendCalls(
      [
        pot.announceTaskCall({
          treasury: project.treasury,
          what: what2,
          payee: workerAccount,
          maxDollars: 3n * DOLLAR,
          shareBps: share2,
        }),
      ],
      31337,
    );
    const second = await onChain(book, 2n);
    const notice2 = await reads.readNoticeFor(read, project.treasury, share2);
    await passTime(notice2.noticeSecs + 120);
    await checkIn(w, project);
    await walletOf(workerAccount).sendCalls(
      [
        pot.takeTaskCall({
          treasury: project.treasury,
          serial: 2n,
          minAmount: 3n * DOLLAR,
        }),
      ],
      31337,
    );
    const takenTwo = await onChain(book, 2n);
    same(
      takenTwo.state,
      "taken",
      "a second task was taken and nobody will settle it",
    );
    check(second.serial === 2n, "it is the book's second task");
    // Its due date passes with nothing pressed by anyone; ten minutes later the server's helper settles the project.
    await passTime(notice2.dueSecs + 700);
    let returned = await onChain(book, 2n);
    for (let i = 0; i < 240 && returned.state === "taken"; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      returned = await onChain(book, 2n);
    }
    same(
      returned.state,
      "returned",
      "the server's helper returned the money of the task that ran out",
    );
    same(
      returned.returned,
      returned.setAside,
      "all of it is back in the project",
    );
    const afterRun = await waitForRecord(
      project.key,
      "the server read the task that ran out",
      (n) => rowOf(n, 2)?.state === "returned",
    );
    plus(
      checkAgainstContracts(
        afterRun.content,
        {
          paidToWorkers: String(pay),
          noteClaims: String(owed),
          endedAt: await endedAt(book, [1n, 2n]),
        },
        true,
      ),
      `field-by-field checks of the record against the contracts at block ${afterRun.content.asOf.block} (a task that ran out)`,
    );
    // What the pages say at the end is what the record says. The holder's news names the ending (a task that ended more than 28
    // days before the record is no longer news, so the first one has left the list by now); the Money tab says how much room is
    // left for tasks, in the record's own number; the team's Tasks tab reads each task in the network's words.
    await viewer.goto("/you");
    const ended = viewer.getByTestId("news-row");
    await expect(
      ended.filter({
        hasText:
          "ended and nothing was paid. The money went back to the project.",
      }),
    ).toHaveCount(1);
    ok(
      "the holder's news tells both endings: the task paid in part, and the one that ran out",
    );
    await shot(viewer, "09-holder-news-end");
    const last = (await newestRecord(project.key)) as NonNullable<
      Awaited<ReturnType<typeof newestRecord>>
    >;
    await viewer.goto(link);
    await viewer.getByTestId("tab-money").click();
    await expect(viewer.getByTestId("tasks-room")).toContainText(
      `Room left for tasks: ${percentOfBps(last.content.tasks?.cap.roomBps ?? 0)} of the project's money`,
      { timeout: 30_000 },
    );
    ok("the Money tab says the room left for tasks, as the record says it");
    await founder.goto(link);
    await founder.getByTestId("tab-tasks").click();
    // A plan with no task record here (the second task was planned on the chain) is read from the network's row alone.
    await expect(founder.getByText("Ran out. Nothing was paid.")).toHaveCount(
      1,
      { timeout: 30_000 },
    );
    await expect(
      founder.getByText("The money went back to the project."),
    ).toHaveCount(1);
    ok(
      "the team's Tasks tab reads the task that ran out in the network's words",
    );
    await shot(founder, "10-team-tasks-end");
    const jobs = helperJobs();
    check(
      jobs.length >= 1 &&
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
  } catch (error) {
    for (const [i, page] of pages.entries()) {
      const words = await page
        .locator("body")
        .innerText()
        .catch(() => "(the page is gone)");
      console.log(`--- browser ${i} at ${page.url()}\n${words.slice(0, 1500)}`);
      if (RUN.shots)
        await page
          .screenshot({ path: `${RUN.shots}/tasks-failed-${i}.png` })
          .catch(() => undefined);
    }
    if (projectKey) {
      const last = await newestRecord(projectKey).catch(() => null);
      console.log(
        `--- newest record: ${JSON.stringify(last?.content.tasks ?? null).slice(0, 1500)}`,
      );
    }
    throw error;
  } finally {
    stopMiner();
    for (const page of pages) await page.context().close();
  }
});
