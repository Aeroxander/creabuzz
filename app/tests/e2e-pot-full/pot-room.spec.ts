import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { call, passTime } from "../anvil/rpc";
import { giveDollars } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import {
  backedWords,
  feedDollars,
  netSentence,
  roundingNote,
  sumHours,
  tookOutWords,
} from "../../src/features/feed/feed-words";
import {
  backInApp,
  check,
  checkAgainstContracts,
  NOT_RUNNABLE,
  newestRecord,
  ok,
  plus,
  query,
  RUN,
  same,
  secretKeyOf,
  signedRoomPost,
  startAndLaunch,
  startMiner,
  syncClock,
  tryPublish,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(NOT_RUNNABLE !== null, NOT_RUNNABLE ?? "");

/**
 * Step 3, the page, the live feed and the holder room, joined up (`scripts/pot-full-loop.sh`): the real server with its chain
 * reader and its room rule, a local chain, and the app's own build in Chromium. One journey:
 *
 *   a founder starts a project and launches it; a visitor with no account and no wallet opens its link and reads the page; two
 *   people back it in the app (the last step of Back links each account to the wallet that made it) and one takes out; the live
 *   feed says so with rounded amounts, no names and the money that came in; the holders write in the room, a stranger and an
 *   account with no wallet are refused in the server's own words, the team removes a post and sets perks; and after taking out
 *   and one time unit the person who left is read-only, in the app and for the server.
 *
 * The server's room rule is the real one; nothing is mocked. Every figure on the feed is the signed record's, and the record
 * is compared with the contracts' own views (scripts/chain-loop-pot-check.py, which also recomputes the four step 3 keys from
 * the node's raw logs).
 */

const BANNER =
  "You can take your money out any time. Nothing here promises a profit.";
const NOT_A_RETURN = "This can go up or down. It is not a return.";
const PUBLIC_LINE = "Posts and votes are public.";
const READ_LINE = "Anyone can read this room.";
const MAY_NOT_WRITE = "Only people who back this project can write here.";
/** The sentences the real server gives (docs/next-version/ROOM-AND-SEASON-RECORDS.md, section 3). */
const SERVER_NO_LINK =
  "link your wallet to your account first, so the server can see that you back this project";
const SERVER_NOT_HOLDING =
  "only people who back this project can write in its room";

const composer = (page: Page) =>
  page.getByLabel("Write to the people who back this");

/** What a person sees in the room's list, as plain text. */
async function roomText(page: Page): Promise<string> {
  return (await page.getByTestId("room-list").textContent()) ?? "";
}

test("a visitor reads the page, two back and one takes out, the feed and the room follow, and a leaver is read-only after one unit", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const w = await worldOnThisChain();
  const [holderA, holderB, strangerAccount] = [
    w.who.member,
    w.who.backer,
    w.who.stranger,
  ];
  const stopMiner = startMiner();
  const pages: Page[] = [];
  const read = (to: string, data: string) => call(to, data);
  const shot = async (page: Page, name: string) => {
    if (!RUN.shots) return;
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${RUN.shots}/room-${name}.png` });
  };
  try {
    // ── a founder starts a project and launches it ────────────────────────────────────────────────────────────────
    const founder = await phone(browser);
    pages.push(founder);
    await installAnvilWallet(founder, w.who.founder);
    await newPerson(founder, `Fay ${NAME_TAG}`);
    const name = `Lantern ${NAME_TAG}`;
    const started = await startAndLaunch(w, founder, name);
    const { link, project, founderPub, projectId } = started;
    ok(`the founder started "${name}" and launched it on the chain (${link})`);
    await waitForRecord(project.key, "the project is known", () => true);

    // ── a visitor with no account and no wallet opens the link and understands the page ───────────────────────────
    const visitor = await phone(browser);
    pages.push(visitor);
    await visitor.goto(link);
    await expect(visitor.getByTestId("project-name")).toHaveText(name);
    await expect(visitor.getByTestId("top-money")).toContainText(NOT_A_RETURN, {
      timeout: 30_000,
    });
    ok(`the visitor reads "${NOT_A_RETURN}" under the project's money`);
    await expect(visitor.getByTestId("top-take-out-now")).toHaveText(
      /^Taking out now would give .+ for each Share\.$/,
    );
    ok("the visitor reads what taking out now would give for each Share");
    await expect(visitor.getByTestId("top-play-money")).toContainText(
      "play money",
    );
    ok("the page says in plain words that the dollars are play money");
    await expect(visitor.getByText(BANNER)).toHaveCount(1);
    ok("the banner is on the page once, word for word");
    await expect(visitor.getByTestId("backing-box")).toHaveCount(1);
    await expect(
      visitor.getByRole("heading", { name: "Back this project" }),
    ).toHaveCount(1);
    ok("there is exactly one way to Back on the page");
    // Everything above is in view on the first phone screen (390 x 844 here; the app's own spec holds 360 x 640).
    for (const id of ["project-name", "top-money", "top-banner"])
      await expect(visitor.getByTestId(id)).toBeInViewport();
    ok(
      "the name, the money with its line and the banner are in view without scrolling",
    );
    await shot(visitor, "01-visitor-page");
    // Share: the one link, a picture made on the device, and nothing on it that names an amount or a gain.
    await visitor.getByTestId("share-open").click();
    await expect(visitor.getByTestId("share-sheet")).toBeVisible();
    const shareLink = await visitor
      .getByTestId("share-link")
      .locator("input")
      .or(visitor.getByTestId("share-link"))
      .first()
      .inputValue();
    same(
      new URL(shareLink).pathname,
      link,
      "the share link is the project's own link",
    );
    const picture = visitor.getByTestId("share-picture");
    await expect(picture).toBeVisible({ timeout: 20_000 });
    const alt = (await picture.getAttribute("alt")) ?? "";
    check(
      !/[\d$%]|dollar|price|gain|profit|return|worth|value/i.test(
        alt.replace(name, ""),
      ),
      `the share card's description carries no amount and no gain figure ("${alt}")`,
    );
    await visitor.getByRole("button", { name: "Close" }).first().click();
    // The server's own preview of the link (what a chat shows) carries the project's name and no money.
    const preview = await fetch(`${RUN.relay}${link}`, {
      headers: { "user-agent": "facebookexternalhit/1.1", accept: "text/html" },
    }).then((r) => r.text());
    check(
      preview.includes(name) && !/\$|dollar|%/i.test(preview.slice(0, 4000)),
      "the server's link preview names the project and carries no amount",
    );
    // The room reads for anyone and says who may write.
    await visitor.getByTestId("tab-room").click();
    await expect(visitor.getByTestId("room-read-line")).toHaveText(READ_LINE);
    await expect(
      visitor.getByTestId("room").getByText(MAY_NOT_WRITE),
    ).toHaveCount(1);
    await expect(composer(visitor)).toHaveCount(0);
    ok(
      "the visitor can read the room and is told only people who back can write",
    );

    // ── two people back it in the app ─────────────────────────────────────────────────────────────────────────────
    // Hana ticks the box that links her account to her wallet when she Backs; Ben does not (the box starts unticked), and meets
    // the same link as one press in the room when he first wants to write.
    const person = async (
      account: string,
      who: string,
      linkWallet: boolean,
    ) => {
      const page = await phone(browser);
      pages.push(page);
      await installAnvilWallet(page, account);
      await newPerson(page, `${who} ${NAME_TAG}`);
      await giveDollars(w, account);
      await page.goto(link);
      await backInApp(page, 150, { linkWallet });
      const pub = getPublicKey(await secretKeyOf(page));
      return { page, pub, key: await secretKeyOf(page), account };
    };
    const hana = await person(holderA, "Hana", true);
    const ben = await person(holderB, "Ben", false);
    let hanaLinks = 0;
    for (let i = 0; i < 40 && hanaLinks === 0; i += 1) {
      hanaLinks = (
        await query({ kinds: [37017], authors: [hana.pub], limit: 5 })
      ).length;
      if (hanaLinks === 0) await new Promise((r) => setTimeout(r, 500));
    }
    check(
      hanaLinks > 0,
      "Hana ticked the box, and her Back ended by linking the account to the wallet that made it (no extra screen)",
    );
    // Ben left the box as it was (unticked): his Back went out and nothing was published about his wallet.
    await new Promise((r) => setTimeout(r, 3_000));
    same(
      (await query({ kinds: [37017], authors: [ben.pub], limit: 5 })).length,
      0,
      "Ben did not tick the box: his Back linked nothing, and his wallet was not made public",
    );
    const both = await waitForRecord(
      project.key,
      "both backers' money is in",
      (n) => n.totals.joined === "300000000",
    );
    ok(`the server read both Backs: ${both.content.holders.length} holders`);

    // ── the room: a stranger and an account with no wallet are refused in the server's words ──────────────────────
    const stranger = await phone(browser);
    pages.push(stranger);
    await installAnvilWallet(stranger, strangerAccount);
    await newPerson(stranger, `Sam ${NAME_TAG}`);
    await stranger.goto(link);
    await stranger.getByTestId("tab-room").click();
    await expect(stranger.getByTestId("room-read-line")).toBeVisible({
      timeout: 20_000,
    });
    await expect(composer(stranger)).toHaveCount(0);
    ok("a stranger is offered no composer in the app, only the way to Back");
    const strangerKey = await secretKeyOf(stranger);
    const refusedNoLink = await tryPublish(
      signedRoomPost(
        strangerKey,
        "Let me in",
        founderPub,
        projectId,
        project.key,
      ),
      strangerKey,
    );
    check(
      !refusedNoLink.accepted && refusedNoLink.text.includes(SERVER_NO_LINK),
      `an account with no linked wallet is refused with the server's words ("${SERVER_NO_LINK}")`,
    );
    const roomBefore = await query({
      kinds: [1],
      "#a": [`37001:${founderPub}:${projectId}`],
      "#t": [`room:${project.key}`],
      limit: 20,
    });
    same(roomBefore.length, 0, "the refused post is not in the room");

    // ── the holders write ─────────────────────────────────────────────────────────────────────────────────────────
    await hana.page.goto(link);
    await hana.page.getByTestId("tab-room").click();
    await expect(composer(hana.page)).toBeVisible({ timeout: 40_000 });
    // Ben holds Shares but did not tick the box: his room shows, right where the writing box would be, the one press that links
    // his account to his wallet (with the sentence that says the link is public), and the press works for the wallet that
    // already holds Shares. Until he presses it, the server would refuse him in its own words.
    await ben.page.goto(link);
    await ben.page.getByTestId("tab-room").click();
    const needsLink = ben.page.getByTestId("room-needs-link");
    await expect(needsLink).toBeVisible({ timeout: 40_000 });
    await expect(composer(ben.page)).toHaveCount(0);
    await expect(needsLink).toContainText(
      "Anyone on this server can see the link",
    );
    const benKey = await secretKeyOf(ben.page);
    const benRefused = await tryPublish(
      signedRoomPost(benKey, "Too early", founderPub, projectId, project.key),
      benKey,
    );
    check(
      !benRefused.accepted && benRefused.text.includes(SERVER_NO_LINK),
      "a holder who did not tick the box is refused until the account is linked, in the server's words",
    );
    await needsLink.getByTestId("room-confirm").click();
    await expect(composer(ben.page)).toBeVisible({ timeout: 60_000 });
    check(
      (await query({ kinds: [37017], authors: [ben.pub], limit: 5 })).length >
        0,
      "Ben pressed the one link step in the room, and the account is linked to the wallet that holds his Shares",
    );
    await expect(hana.page.getByTestId("room-public-line")).toHaveText(
      PUBLIC_LINE,
    );
    ok(`the composer says "${PUBLIC_LINE}" where people post`);
    await composer(hana.page).focus();
    await hana.page.keyboard.type("Hello from Hana. Who wants to test a lamp?");
    await hana.page.keyboard.press("Control+Enter");
    await expect(hana.page.getByTestId("room-list")).toContainText(
      "Who wants to test a lamp?",
      { timeout: 30_000 },
    );
    await composer(ben.page).focus();
    await ben.page.keyboard.type("Ben here. I will bring a ladder.");
    await ben.page.keyboard.press("Control+Enter");
    await expect(ben.page.getByTestId("room-list")).toContainText(
      "I will bring a ladder.",
      { timeout: 30_000 },
    );
    const room = await query({
      kinds: [1],
      "#a": [`37001:${founderPub}:${projectId}`],
      "#t": [`room:${project.key}`],
      limit: 20,
    });
    same(
      room.length,
      2,
      "the server holds exactly the two holders' room posts",
    );
    check(
      room.every(
        (e) =>
          e.tags.some((t) => t[0] === "t" && t[1] === `room:${project.key}`) &&
          e.tags.some(
            (t) => t[0] === "a" && t[1] === `37001:${founderPub}:${projectId}`,
          ),
      ),
      "each room post carries the project's address and the room's tag",
    );
    // The visitor, who has no account, reads both.
    await visitor.reload();
    await visitor.getByTestId("tab-room").click();
    await expect(visitor.getByTestId("room-list")).toContainText(
      "Who wants to test a lamp?",
      { timeout: 30_000 },
    );
    check(
      (await roomText(visitor)).includes("I will bring a ladder."),
      "a visitor with no account reads both posts",
    );
    await shot(hana.page, "02-holder-room");

    // ── the team removes a post and sets perks ────────────────────────────────────────────────────────────────────
    await composer(hana.page).focus();
    await hana.page.keyboard.type("Buy my thing at a very good price!");
    await hana.page.keyboard.press("Control+Enter");
    await expect(hana.page.getByTestId("room-list")).toContainText(
      "very good price",
      { timeout: 30_000 },
    );
    await founder.goto(link);
    await founder.getByTestId("tab-room").click();
    const spam = founder
      .getByTestId("room-post")
      .filter({ hasText: "very good price" });
    await expect(spam).toBeVisible({ timeout: 30_000 });
    await spam
      .getByRole("button", { name: `More actions for Hana ${NAME_TAG}'s post` })
      .tap();
    await founder.getByRole("button", { name: "Remove this post" }).tap();
    const removeSheet = founder.getByTestId("remove-sheet");
    await removeSheet
      .getByLabel("Say why. The reason is kept in a public log.")
      .fill("An advert, not for this room.");
    await removeSheet.getByRole("button", { name: "Remove" }).tap();
    await expect(
      founder.getByTestId("room-list").getByText("very good price"),
    ).toHaveCount(0, { timeout: 30_000 });
    await visitor.reload();
    await visitor.getByTestId("tab-room").click();
    await expect(visitor.getByTestId("room-list")).toContainText(
      "Who wants to test a lamp?",
      { timeout: 30_000 },
    );
    check(
      !(await roomText(visitor)).includes("very good price"),
      "the team removed a post and a visitor no longer reads it",
    );
    const stillThere = await query({
      kinds: [1],
      "#t": [`room:${project.key}`],
      limit: 20,
    });
    check(
      !stillThere.some((e) => e.content.includes("very good price")) &&
        stillThere.length === 2,
      "the server no longer serves the removed post (the other two stay)",
    );
    const [recordBefore] = await query({
      kinds: [37001],
      authors: [founderPub],
      "#d": [projectId],
      limit: 1,
    });
    await founder.getByRole("button", { name: "Add perks" }).tap();
    const perks = founder.getByTestId("perks-sheet");
    await perks
      .getByLabel("What do people who back this get?")
      .fill("Early looks at each new lamp.");
    await perks.getByRole("button", { name: "Save" }).tap();
    await visitor.reload();
    await visitor.getByTestId("tab-room").click();
    await expect(visitor.getByTestId("room-perks")).toContainText(
      "Early looks at each new lamp.",
      { timeout: 30_000 },
    );
    const [recordAfter] = await query({
      kinds: [37001],
      authors: [founderPub],
      "#d": [projectId],
      limit: 1,
    });
    const without = (tags: string[][]) =>
      JSON.stringify(tags.filter((t) => t[0] !== "perks").sort());
    same(
      without(recordAfter.tags),
      without(recordBefore.tags),
      "setting perks changed no other tag of the project's record (the chain key is still there)",
    );
    check(
      recordAfter.tags.some(
        (t) => t[0] === "chain-key" && t[1] === project.key,
      ),
      "the project's record still names its launch after the perks were saved",
    );

    // ── Ben takes out; the feed says so ───────────────────────────────────────────────────────────────────────────
    await ben.page.goto(link);
    await ben.page.getByTestId("tab-money").click();
    await expect(ben.page.getByTestId("holding-take-out")).toBeVisible({
      timeout: 30_000,
    });
    await ben.page.getByTestId("holding-take-out").click();
    await expect(ben.page.getByTestId("takeout-sheet")).toBeVisible();
    await ben.page.getByTestId("sheet-confirm").click();
    await expect(ben.page.getByTestId("takeout-sheet")).toBeHidden({
      timeout: 30_000,
    });
    const benShares = await reads.balanceOf(read, project.shares, holderB);
    same(benShares, 0n, "Ben holds no Shares after taking out");
    const leftAt = await (await import("../e2e/helpers/live-chain")).chainNow();
    const afterOut = await waitForRecord(
      project.key,
      "the take-out is in the feed",
      (n) => (n.feed?.hours ?? []).some((h) => h.tookOut > 0),
    );
    const feed = afterOut.content.feed;
    if (!feed) throw new Error("the record has no feed");
    plus(
      checkAgainstContracts(afterOut.content, {}, true),
      `field-by-field checks of the record against the contracts (the four step 3 keys recomputed from the raw logs) at block ${afterOut.content.asOf.block}`,
    );
    const roundTo = BigInt(feed.roundTo);
    check(
      feed.hours.every(
        (h) => BigInt(h.net.amount) % roundTo === 0n && h.joins >= 0,
      ) && roundTo === 100_000_000n,
      "every amount in the feed is a whole 100 dollars (100,000,000 in the record's own units)",
    );
    const sum = sumHours(
      feed.hours.map((h) => ({
        ...h,
        net: { dir: h.net.dir, amount: BigInt(h.net.amount) },
      })),
    );
    same(sum.joins, 2, "the feed counts two joins");
    same(sum.tookOut, 1, "the feed counts one take-out");
    await visitor.goto(link);
    const feedBox = visitor.getByTestId("project-feed");
    await expect(feedBox).toBeVisible({ timeout: 30_000 });
    await expect(feedBox.getByTestId("feed-rounding")).toHaveText(
      roundingNote(roundTo),
    );
    await expect(feedBox.getByTestId("feed-lately")).toContainText(
      `Last 2 days: ${backedWords(2)}, ${tookOutWords(1)}.`,
    );
    await expect(feedBox.getByTestId("feed-net")).toHaveText(netSentence(sum));
    ok(
      `the feed reads "Last 2 days: 2 backed, 1 took out." and "${netSentence(sum)}" (the net money in, rounded)`,
    );
    const feedText = (await feedBox.textContent()) ?? "";
    check(
      !feedText.includes(`Hana ${NAME_TAG}`) &&
        !feedText.includes(`Ben ${NAME_TAG}`) &&
        !/0x[0-9a-f]{6}/i.test(feedText) &&
        !/volume/i.test(feedText),
      "the feed names nobody, shows no address and never says volume",
    );
    check(
      sum.net > 0n && feedText.includes(feedDollars(sum.net)),
      `the feed's one amount is the money in less the money out: ${feedDollars(sum.net)}`,
    );
    await shot(visitor, "03-feed");
    // Joins and take-outs are drawn the same way: the same classes (equal weight).
    const classes = async (id: string) =>
      visitor.getByTestId(id).evaluate((el) => el.className);
    same(
      await classes("feed-joins"),
      await classes("feed-took-out"),
      "joins and take-outs are drawn with the very same classes (equal weight)",
    );

    // ── Ben, who took out, still writes for one unit ──────────────────────────────────────────────────────────────
    await ben.page.getByTestId("tab-room").click();
    await expect(ben.page.getByTestId("room-grace")).toContainText(
      "You took out",
      { timeout: 30_000 },
    );
    await expect(composer(ben.page)).toBeVisible();
    await composer(ben.page).focus();
    await ben.page.keyboard.type("Thanks all. I took my money out.");
    await ben.page.keyboard.press("Control+Enter");
    await expect(ben.page.getByTestId("room-list")).toContainText(
      "I took my money out.",
      { timeout: 30_000 },
    );
    ok("a person who took out can still write in the room for one time unit");

    // ── one time unit later, by the chain's clock, the same person can only read ──────────────────────────────────
    await passTime(w.chain.unit + 3_600);
    await waitForRecord(
      project.key,
      "the server's clock is past the unit",
      (n) => n.asOf.time >= leftAt + w.chain.unit + 60,
    );
    const lateKey = ben.key;
    const refused = await tryPublish(
      signedRoomPost(
        lateKey,
        "Let me back in",
        founderPub,
        projectId,
        project.key,
      ),
      lateKey,
    );
    check(
      !refused.accepted && refused.text.includes(SERVER_NOT_HOLDING),
      `after one unit the server refuses the person who left, in its own words ("${SERVER_NOT_HOLDING}")`,
    );
    // The page already holds its signed-in connection; only its clock moves to the chain's (the app judges "one unit later" by
    // the page's own clock), then the room is opened afresh. A page loaded with a clock a week ahead could not sign in at all.
    await ben.page.getByTestId("tab-updates").click();
    await syncClock(ben.page);
    await ben.page.getByTestId("tab-room").click();
    await expect(ben.page.getByTestId("room-read-line")).toBeVisible({
      timeout: 30_000,
    });
    await expect(composer(ben.page)).toHaveCount(0);
    ok(
      "after taking out and one time unit the app shows the person the room read-only",
    );
    // Hana, who still holds, can write.
    await hana.page.goto(link);
    await hana.page.getByTestId("tab-room").click();
    await composer(hana.page).focus();
    await hana.page.keyboard.type("Still here, a week on.");
    await hana.page.keyboard.press("Control+Enter");
    await expect(hana.page.getByTestId("room-list")).toContainText(
      "Still here, a week on.",
      { timeout: 30_000 },
    );
    ok("a holder writes a week later: only the one who left is read-only");
    const finalRecord = await newestRecord(project.key);
    check(
      Boolean(finalRecord),
      "the server still serves the project's numbers",
    );
  } finally {
    stopMiner();
    for (const p of pages) await p.context().close();
  }
});
