import { expect, type Page, test } from "@playwright/test";
import { finalizeEvent } from "nostr-tools/pure";
import { call, passTime, accounts } from "../anvil/rpc";
import { walletOf } from "../anvil/pot-chain";
import { backFor, checkIn } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as potState from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { smallDollarsText } from "../../src/features/pot/pot-words";
import { inSeasonOrder } from "../../src/features/season/season-order";
import {
  buzzAsOperator,
  check,
  checkAgainstContracts,
  type EstablishedJson,
  NOT_RUNNABLE,
  type NumbersJson,
  ok,
  plus,
  query,
  RUN,
  same,
  secretKeyOf,
  startAndLaunch,
  startMiner,
  type StartedProject,
  tryPublish,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(NOT_RUNNABLE !== null, NOT_RUNNABLE ?? "");

/**
 * Step 3, the badge, the ranking by money that stayed, and a season with its demo day, joined up
 * (`scripts/pot-full-loop.sh`): the real server with its chain reader, a local chain whose clock is moved by days, and the app's
 * own build in Chromium.
 *
 *   One founder starts three projects in the app: Alpha (ten people back it and it is run by a Pair), Beta (ten people, one
 *   signer) and Gamma (three people). The operator starts a season with the real `buzz` command; the founder enters Alpha and
 *   Beta from Home; a stranger's entry is refused. A month passes on the chain: Home ranks the three by the money that has
 *   stayed 30 days or more with the number of different accounts beside it (a late buyer who makes Gamma's pot the biggest does
 *   not move it), and the badge is on no project because Alpha has not held 91 days. A quarter passes: the badge appears on
 *   Alpha only, because only Alpha has all three of its inputs. Then demo day (the season's own clock) opens and its page lists
 *   the two projects with their numbers and last updates, in an order that is not money.
 */

const BANNER =
  "You can take your money out any time. Nothing here promises a profit.";
const NOT_A_RETURN = "This can go up or down. It is not a return.";
const DAY = 86_400;

interface StoredLike {
  kind: number;
  tags: string[][];
}

/** The ranking rule the badge states, from the record's own inputs: the three of design 2.6. */
function verdict(e: EstablishedJson): boolean | null {
  if (e.heldBps === null) return null;
  return (
    e.heldBps >= e.rule.minHeldBps &&
    (e.accounts ?? 0) >= e.rule.minAccounts &&
    e.twoSigners
  );
}

async function openProject(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.getByTestId("project-top")).toBeVisible({
    timeout: 30_000,
  });
}

test("a badge by three inputs, a ranking by money that stayed, and a season with its demo day", async ({
  browser,
}) => {
  test.setTimeout(1_500_000);
  const w = await worldOnThisChain();
  const stopMiner = startMiner();
  const pages: Page[] = [];
  const read = (to: string, data: string) => call(to, data);
  const shot = async (page: Page, name: string) => {
    if (!RUN.shots) return;
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${RUN.shots}/seasons-${name}.png` });
  };
  try {
    const all = await accounts();
    // anvil's accounts: 0 admin, 1 founder, 7 the server's helper; the rest back projects. Ten of them hold Alpha and Beta.
    const holders = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((i) => all[i]);
    const lateBuyer = all[13];
    const second = all[3]; // the Pair's other signer (also a holder)

    // ── one founder starts three projects in the app ──────────────────────────────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const alpha = await startAndLaunch(w, founder, `Alpha ${NAME_TAG}`);
    const beta = await startAndLaunch(w, founder, `Beta ${NAME_TAG}`);
    const gamma = await startAndLaunch(w, founder, `Gamma ${NAME_TAG}`);
    ok(
      "the founder started Alpha, Beta and Gamma in the app and launched each on the chain",
    );

    // ── who backs what: Alpha 10 x 20, Beta 10 x 30, Gamma 3 x 80 (money that stays: Beta, Gamma, Alpha) ───────────
    for (const who of holders) await backFor(w, alpha.project, who, 20n);
    for (const who of holders) await backFor(w, beta.project, who, 30n);
    for (const who of holders.slice(0, 3))
      await backFor(w, gamma.project, who, 80n);
    // Alpha has two signers: the founder offers the seat to the Pair of the founder and `second`, who accepts.
    const pairAddress = await potState.pairAddressOf(
      read,
      w.chain.launcher,
      alpha.project.key,
      w.who.founder,
      second,
    );
    await walletOf(w.who.founder).sendCalls(
      [
        pot.handOverCall({
          treasury: alpha.project.treasury,
          next: pairAddress,
          founderLeaves: false,
        }),
      ],
      31337,
    );
    await walletOf(second).sendCalls(
      [pot.makePairCall(w.chain.launcher, alpha.project.key, w.who.founder)],
      31337,
    );
    ok("Alpha is run by a Pair (two signers); Beta and Gamma by one");
    /** The team checks in: a Pair's signer for Alpha, the founder for the others (the weekly check-in keeps the door open). */
    const teamChecksIn = async (p: StartedProject) => {
      if (p === alpha)
        await walletOf(w.who.founder).sendCalls(
          [pot.pairCheckInCall(pairAddress, `0x${"5c".repeat(32)}`)],
          31337,
        );
      else await checkIn(w, p.project);
    };
    const records: Record<string, NumbersJson> = {};
    for (const [p, count] of [
      [alpha, 10],
      [beta, 10],
      [gamma, 3],
    ] as [StartedProject, number][])
      records[p.name] = (
        await waitForRecord(
          p.project.key,
          `${p.name}: all its holders are in`,
          (n) =>
            (n.held?.countedAccounts ?? 0) >= count &&
            (p !== alpha || n.established?.twoSigners === true),
        )
      ).content;
    same(
      records[alpha.name].held?.countedAccounts,
      10,
      "Alpha counts ten accounts",
    );
    same(
      records[gamma.name].held?.countedAccounts,
      3,
      "Gamma counts three accounts",
    );
    same(
      records[alpha.name].established?.twoSigners,
      true,
      "the record says Alpha has two signers",
    );
    same(
      records[beta.name].established?.twoSigners,
      false,
      "the record says Beta has one",
    );

    // ── the operator starts a season; demo day is five minutes away on the server's own clock ─────────────────────
    const startsAt = new Date(Date.now() - DAY * 1000 + 5 * 60_000);
    const iso = startsAt.toISOString().replace(/\.\d+Z$/, "Z");
    const demoAt = startsAt.getTime() + DAY * 1000;
    const started = buzzAsOperator([
      "launchpad",
      "seasons",
      "start",
      "--number",
      "1",
      "--starts",
      iso,
      "--days",
      "1",
    ]);
    check(
      started.status === 0,
      `the operator started season 1 with the real command (${(started.stdout || started.stderr).replace(/\s+/g, " ").slice(0, 160)})`,
    );
    // Only the operator can: a founder's key is refused by the server.
    const [seasonRecord] = await query({ kinds: [37021], limit: 1 });
    check(
      Boolean(seasonRecord) &&
        seasonRecord.tags.some((t) => t[1] === "season-1"),
      "the server holds the season's record",
    );

    // ── the founder enters Alpha and Beta from Home; a stranger's entry is refused ────────────────────────────────
    await founder.goto("/");
    const band = founder.getByRole("region", { name: "Seasons" });
    await expect(band.getByTestId("season-band-words")).toContainText(
      "Season 1 is open. Projects can enter until demo day on",
      { timeout: 30_000 },
    );
    await expect(
      band.getByRole("button", { name: `Enter ${gamma.name}` }),
    ).toBeVisible();
    for (const p of [alpha, beta]) {
      await band.getByRole("button", { name: `Enter ${p.name}` }).click();
      await expect(band.getByText(`${p.name} is in.`)).toBeVisible({
        timeout: 30_000,
      });
    }
    const entries = await query({
      kinds: [47003],
      "#t": ["season-1"],
      limit: 20,
    });
    same(
      entries.filter((e) => e.tags.some((t) => t[0] === "season-entry")).length,
      2,
      "the server holds the founder's two entries",
    );
    const stranger = await phone(browser);
    pages.push(stranger);
    await newPerson(stranger, `Sam ${NAME_TAG}`);
    const strangerKey = await secretKeyOf(stranger);
    const refused = await tryPublish(
      finalizeEvent(
        {
          kind: 47003,
          content: "{}",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["a", gamma.project.coordinate],
            ["t", "season-1"],
            ["season-entry", "1"],
          ],
        },
        strangerKey,
      ),
      strangerKey,
    );
    check(
      !refused.accepted &&
        refused.text.includes("only this project's team can post this"),
      "a stranger's entry for Gamma is refused in the server's own words",
    );
    await shot(founder, "01-band-entered");

    // ── the badge, the day the money has stayed 30 days: no project has it ────────────────────────────────────────
    await passTime(31 * DAY + 3_600);
    for (const p of [alpha, beta, gamma]) await teamChecksIn(p);
    for (const p of [alpha, beta, gamma])
      records[p.name] = (
        await waitForRecord(
          p.project.key,
          `${p.name}: a month later its money has stayed 30 days`,
          (n) =>
            (n.held?.rank?.accounts ?? 0) > 0 &&
            n.asOf.time > records[p.name].asOf.time + 30 * DAY,
        )
      ).content;
    same(
      records[alpha.name].held?.rank?.accounts,
      10,
      "Alpha: ten accounts kept their money 30 days",
    );
    same(
      records[beta.name].held?.rank?.accounts,
      10,
      "Beta: ten accounts kept their money 30 days",
    );
    same(
      records[gamma.name].held?.rank?.accounts,
      3,
      "Gamma: three accounts kept their money 30 days",
    );
    const visitor = await phone(browser);
    pages.push(visitor);
    // What Home reads from the server, counted on the wire (the server's frames to this page): the index and the records it names.
    const wire = {
      total: 0,
      index: 0,
      numbers: 0,
      numbersBytes: 0,
      projects: 0,
      projectBytes: 0,
    };
    visitor.on("websocket", (socket) =>
      socket.on("framereceived", (frame) => {
        const raw =
          typeof frame.payload === "string"
            ? frame.payload
            : frame.payload.toString("utf8");
        const size = Buffer.byteLength(raw);
        wire.total += size;
        try {
          const message = JSON.parse(raw) as [string, string, StoredLike];
          if (message[0] === "EVENT" && message[2]?.kind === 37001) {
            wire.projects += 1;
            wire.projectBytes += size;
          }
          if (message[0] !== "EVENT" || message[2]?.kind !== 39009) return;
          const d = message[2].tags.find((t) => t[0] === "d")?.[1];
          if (d === "explore") wire.index += size;
          else {
            wire.numbers += 1;
            wire.numbersBytes += size;
          }
        } catch {
          // a frame that is not an event is only counted in the total
        }
      }),
    );
    const badgeAt = async (when: string) => {
      for (const p of [alpha, beta, gamma]) {
        const rec = (
          await waitForRecord(p.project.key, `${p.name} read`, () => true)
        ).content;
        const e = rec.established;
        if (!e) throw new Error(`${p.name}: the record has no established key`);
        const want = verdict(e);
        same(
          e.reached,
          want,
          `${when}, ${p.name}: the server's verdict equals the rule on its three inputs (held ${e.heldBps} bps of ${e.rule.minHeldBps}, ${e.accounts} of ${e.rule.minAccounts} accounts, two signers ${e.twoSigners})`,
        );
        await openProject(visitor, p.link);
        await expect(visitor.getByTestId("established-chip")).toHaveCount(
          e.reached === true ? 1 : 0,
        );
        ok(
          `${when}, ${p.name}: the page ${e.reached === true ? "shows" : "does not show"} the Established chip, as the verdict says`,
        );
      }
    };
    await badgeAt("a month in");
    check(
      records[alpha.name].established?.reached === false &&
        records[alpha.name].established?.accounts === 10 &&
        records[alpha.name].established?.twoSigners === true,
      "Alpha has its accounts and its two signers but its money has not stayed 91 days: no badge",
    );

    // ── Home ranks by money that stayed 30 days or more, with the accounts beside it ──────────────────────────────
    interface Index {
      entries: {
        key: string;
        money: string;
        accounts: number;
        windowSecs: number;
      }[];
    }
    let index: Index | null = null;
    // The server looks at its index every ten minutes (its own pace), so the first one can come that long after its start.
    for (let i = 0; i < 720 && !index; i += 1) {
      const [event] = await query({
        kinds: [39009],
        "#d": ["explore"],
        limit: 1,
      });
      if (event) {
        const parsed = JSON.parse(event.content) as Index;
        if (parsed.entries.length >= 3) index = parsed;
      }
      if (!index) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!index) throw new Error("the server never signed its ranking index");
    same(
      index.entries.length,
      3,
      "the server's index lists the three projects",
    );
    const byKey = new Map(
      [alpha, beta, gamma].map((p) => [p.project.key, p] as const),
    );
    const orderOnServer = index.entries.map((e) => byKey.get(e.key)?.name);
    same(
      JSON.stringify(orderOnServer),
      JSON.stringify([beta.name, gamma.name, alpha.name]),
      "the index orders them by money that stayed: Beta, Gamma, Alpha",
    );
    check(
      index.entries.every((e) => e.windowSecs === 30 * DAY) &&
        JSON.stringify(Object.keys(index.entries[0]).sort()) ===
          JSON.stringify([
            "a",
            "accounts",
            "key",
            "launchedAt",
            "money",
            "reached",
            "windowSecs",
          ]),
      "each entry holds the money, the accounts and the window and nothing else (no price, no pot, no name)",
    );
    const home = async () => {
      Object.assign(wire, {
        total: 0,
        index: 0,
        numbers: 0,
        numbersBytes: 0,
        projects: 0,
        projectBytes: 0,
      });
      await visitor.goto("/");
      const section = visitor.getByTestId("home-ranked");
      await expect(section.getByTestId("ranked-row")).toHaveCount(3, {
        timeout: 40_000,
      });
      return section;
    };
    const section = await home();
    const rows = section.getByTestId("ranked-row");
    for (const [i, e] of index.entries.entries()) {
      const p = byKey.get(e.key);
      if (!p) throw new Error("unknown project in the index");
      await expect(rows.nth(i)).toContainText(p.name);
      await expect(rows.nth(i)).toContainText(
        `${smallDollarsText(BigInt(e.money))} kept 30 days or more by ${e.accounts} people.`,
      );
    }
    ok(
      "Home ranks Beta, Gamma, Alpha by the money that stayed 30 days or more, with the number of different accounts beside each",
    );
    await visitor.waitForTimeout(3_000);
    check(
      wire.index > 0 && wire.index < 8_192 && wire.numbers <= 10 + 3,
      `what Home reads for the ranking: the index is ${wire.index} bytes, and ${wire.numbers} numbers records of ${wire.numbersBytes} bytes besides it, with ${wire.projects} project records of ${wire.projectBytes} bytes (the whole page's frames from the server: ${wire.total} bytes)`,
    );
    await expect(section.getByText(NOT_A_RETURN)).toHaveCount(1);
    ok(
      'the ranking says "This can go up or down. It is not a return." once, under its heading',
    );
    await shot(visitor, "02-ranking");
    plus(
      checkAgainstContracts(records[alpha.name], {}, true) +
        checkAgainstContracts(records[beta.name], {}, true) +
        checkAgainstContracts(records[gamma.name], {}, true),
      "field-by-field checks of the three records against the contracts (held, feed, streaks and established recomputed from the raw logs)",
    );

    // ── a late buyer makes Gamma's pot the biggest: the ranking, which is not a price, does not move ──────────────
    await teamChecksIn(gamma);
    await backFor(w, gamma.project, lateBuyer, 900n);
    const gammaBig = await waitForRecord(
      gamma.project.key,
      "the late buyer's money is in Gamma",
      (n) => BigInt(n.money.pot) > BigInt(records[beta.name].money.pot),
    );
    check(
      BigInt(gammaBig.content.money.pot) > BigInt(records[beta.name].money.pot),
      "Gamma's pot is now bigger than Beta's",
    );
    const after = await home();
    const names = await after.getByTestId("ranked-row").allTextContents();
    check(
      names[0].includes(beta.name) &&
        names[1].includes(gamma.name) &&
        names[2].includes(alpha.name),
      "the ranking did not move: a late buyer's money has not stayed, and the pot is not what ranks",
    );

    // ── a quarter in: the badge appears on Alpha, which alone has all three inputs ────────────────────────────────
    await passTime(62 * DAY);
    for (const p of [alpha, beta, gamma]) await teamChecksIn(p);
    await waitForRecord(
      alpha.project.key,
      "Alpha has held for 91 days",
      (n) => n.established?.reached === true,
      120,
    );
    for (const p of [beta, gamma])
      await waitForRecord(
        p.project.key,
        `${p.name} read a quarter in`,
        (n) => n.asOf.time > records[p.name].asOf.time + 60 * DAY,
        120,
      );
    await badgeAt("a quarter in");
    const quarter = (
      await waitForRecord(alpha.project.key, "Alpha read", () => true)
    ).content;
    check(
      quarter.established?.reached === true &&
        (quarter.established.heldBps ?? 0) >= 6000 &&
        quarter.established.accounts === 10 &&
        quarter.established.twoSigners === true,
      "Alpha: 60% held 91 days, ten accounts and two signers: the server says Established",
    );
    const betaNow = (
      await waitForRecord(beta.project.key, "Beta read", () => true)
    ).content;
    check(
      betaNow.established?.reached === false &&
        (betaNow.established.heldBps ?? 0) >= 6000 &&
        betaNow.established.accounts === 10 &&
        betaNow.established.twoSigners === false,
      "Beta has the money and the accounts but one signer: no badge",
    );
    const gammaNow = (
      await waitForRecord(gamma.project.key, "Gamma read", () => true)
    ).content;
    check(
      gammaNow.established?.reached === false &&
        (gammaNow.established.accounts ?? 99) < 10,
      "Gamma has three accounts: no badge",
    );
    // The chip opens the sheet: three lines, from the record's own rule.
    await openProject(visitor, alpha.link);
    await visitor.getByTestId("established-chip").click();
    const sheet = visitor.getByTestId("established-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("established-rows")).toContainText("10");
    await shot(visitor, "03-established-sheet");
    await visitor.getByRole("button", { name: "Close" }).first().click();
    plus(
      checkAgainstContracts(quarter, {}, true) +
        checkAgainstContracts(betaNow, {}, true) +
        checkAgainstContracts(gammaNow, {}, true),
      "field-by-field checks of the three records a quarter in, against the contracts",
    );

    // ── demo day: the season's own clock; its page lists the two projects, in an order that is not money ──────────
    while (Date.now() < demoAt + 5_000)
      await new Promise((r) => setTimeout(r, 2_000));
    const late = await visitor.context().newPage();
    await late.goto("/");
    const demoBand = late.getByRole("region", { name: "Seasons" });
    await expect(demoBand.getByTestId("season-band-words")).toHaveText(
      "Demo day: 2 projects show what they made.",
      { timeout: 40_000 },
    );
    ok("on demo day Home says two projects show what they made");
    await demoBand.getByRole("link", { name: "See demo day" }).click();
    await expect(late).toHaveURL(/\/season\/1$/);
    await expect(late.getByRole("heading", { level: 1 })).toHaveText(
      "Season 1",
    );
    const cards = late.getByTestId("demo-card");
    await expect(cards).toHaveCount(2, { timeout: 40_000 });
    const wantOrder = inSeasonOrder(1, [
      alpha.project.coordinate,
      beta.project.coordinate,
    ]).map((c) => (c === alpha.project.coordinate ? alpha : beta));
    await expect(cards.getByRole("heading")).toHaveText(
      wantOrder.map((p) => p.name),
    );
    ok(
      "the demo day page lists exactly the two entered projects, in the season's own order (a hash, not money)",
    );
    for (const [i, p] of wantOrder.entries()) {
      const rec = (await waitForRecord(p.project.key, "read", () => true))
        .content;
      await expect(cards.nth(i).getByTestId("demo-money")).toContainText(
        `The project's money ${smallDollarsText(BigInt(rec.money.pot))}`,
      );
      await expect(cards.nth(i).getByTestId("demo-update")).toBeVisible();
    }
    ok(
      "each card shows the project's money from its signed record, and its last update",
    );
    await expect(
      late.getByTestId("demo-list").getByText(NOT_A_RETURN),
    ).toHaveCount(1);
    await expect(late.getByText(BANNER)).toHaveCount(1);
    await expect(late.getByTestId("demo-not-advice")).toBeVisible();
    ok(
      "the page has the banner and the line once, and says being on it is not advice",
    );
    check(
      !(await late.getByTestId("season-page").textContent())?.includes(
        gamma.name,
      ),
      "Gamma, which did not enter, is not on the page",
    );
    await shot(late, "04-demo-day");
  } finally {
    stopMiner();
    for (const p of pages) await p.context().close();
  }
});
