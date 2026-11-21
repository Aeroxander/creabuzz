import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { fingerprintLine } from "../../src/features/earlier-grant/earlier-grant-words";
import {
  goalRecordTemplate,
  projectRecordTemplate,
} from "../../src/features/start/start-record";
import { potProblem } from "../../src/features/money/pot-copy";
import { walletOf } from "../anvil/pot-chain";
import { call } from "../anvil/rpc";
import { backFor, launchProject } from "../e2e/helpers/live-chain";
import { installAnvilWallet } from "../e2e/helpers/live-wallet";
import { newPerson, phone, RUN as NAME_TAG } from "../e2e-real/people";
import {
  atNarrowPhone,
  check,
  checkAgainstContracts,
  nameTheLaunch,
  NOT_RUNNABLE,
  ok,
  plus,
  publishSigned,
  same,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

test.skip(
  NOT_RUNNABLE !== null ||
    process.env.POT_WORLD_KIND !== "earlier" ||
    !process.env.POT_EARLIER_FILE,
  NOT_RUNNABLE ??
    "run by scripts/pot-full-loop.sh in the world deployed with the earlier-grant settings",
);

/**
 * Step 4's earlier backers' claim, joined up (`scripts/pot-full-loop.sh`, a world deployed with the six EARLIER_* settings for an
 * INVENTED list and an app built with the claim page's three settings): the real server with its chain reader, a local chain,
 * and the app's own build in Chromium. One journey:
 *
 *   project zero is launched (its records signed by a key made from a public string: it is worth nothing); a listed account
 *   opens its own link, sees its grant and what the contract does, cannot press until it has opened the text and ticked the box,
 *   claims, and the grant, the acceptance and the claimed count are on the chain and in the record; an account with no row opens
 *   that link and is told it is not for them, and the contract refuses its claim in the app's words; the same row cannot be
 *   claimed twice; and the record equals the contracts' own views.
 *
 * The list is made by scripts/pot-earlier-list.mjs from anvil's public accounts, held only in the run's temporary folder.
 */

const BANNER =
  "You can take your money out any time. Nothing here promises a profit.";
const FOUNDER_KEY = createHash("sha256")
  .update("creaton earlier-grant test world")
  .digest();

interface List {
  projectId: string;
  key: string;
  root: string;
  total: string;
  rows: number;
  links: { index: number; account: string; amount: string; fragment: string }[];
}

test("a listed account claims its row, an account with no row is refused, and a row cannot be claimed twice", async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const list = JSON.parse(
    readFileSync(resolve(process.env.POT_EARLIER_FILE ?? ""), "utf8"),
  ) as List;
  const w = await worldOnThisChain();
  const stopMiner = startMiner();
  const read = (to: string, data: string) => call(to, data);
  const pages: Page[] = [];
  const [claimant, outsider] = [w.who.second, w.who.stranger];
  const mine = list.links.find((l) => l.account === claimant);
  const others = list.links.filter((l) => l.account !== claimant);
  if (!mine) throw new Error("the invented list has no row for the claimant");
  try {
    // ── project zero: records signed by the made-up key, launched by the founder the deployment was told ───────────────
    const pub = getPublicKey(FOUNDER_KEY);
    const now = Math.floor(Date.now() / 1000);
    const draft = {
      name: "Project zero",
      goal: "A first project, older than this network.",
      how: "Its earlier backers are listed.",
    };
    await publishSigned(
      finalizeEvent(
        {
          kind: 0,
          tags: [],
          content: JSON.stringify({ name: `Zed ${NAME_TAG}` }),
          created_at: now,
        },
        FOUNDER_KEY,
      ),
      FOUNDER_KEY,
    );
    await publishSigned(
      finalizeEvent(projectRecordTemplate("zero", draft, now), FOUNDER_KEY),
      FOUNDER_KEY,
    );
    await publishSigned(
      finalizeEvent(
        { ...goalRecordTemplate(pub, "zero", draft), created_at: now },
        FOUNDER_KEY,
      ),
      FOUNDER_KEY,
    );
    const project = await launchProject(w, "zero", pub);
    same(
      project.projectId,
      list.projectId,
      "project zero's id is the one the deployment was given",
    );
    same(
      project.key,
      list.key,
      "and its key is the one the claim contract was bound to",
    );
    await nameTheLaunch(FOUNDER_KEY, pub, "zero", project.key);
    await backFor(w, project, w.who.backer, 50n);
    const first = await waitForRecord(
      project.key,
      "the record names the claim contract, bound and nothing claimed",
      (n) => {
        const g = (
          n as unknown as {
            earlierGrants: { bound: boolean; claimedRows: number } | null;
          }
        ).earlierGrants;
        return (
          g !== null &&
          g.bound === true &&
          g.claimedRows === 0 &&
          n.totals.joined === "50000000"
        );
      },
    );
    type Grants = {
      contract: string;
      bound: boolean;
      root: string;
      textHash: string;
      total: string;
      rows: number;
      claimedRows: number;
      claimedTotal: string;
    };
    const grantsOf = (n: unknown) =>
      (n as { earlierGrants: Grants | null }).earlierGrants;
    same(
      grantsOf(first.content)?.root,
      list.root,
      "the record carries the list's one fingerprint",
    );
    same(grantsOf(first.content)?.total, list.total, "and the pool");
    same(grantsOf(first.content)?.rows, list.rows, "and the number of rows");
    check(
      !JSON.stringify(first.content).includes(list.links[1]?.fragment ?? "#"),
      "no row and no proof is in the record",
    );
    plus(
      checkAgainstContracts(first.content, {}, true),
      `field-by-field checks of the record against the contracts, claim contract bound, at block ${first.content.asOf.block}`,
    );
    const claims = grantsOf(first.content)?.contract as string;

    // ── the listed account opens its own link ──────────────────────────────────────────────────────────────────────────
    const page = await phone(browser);
    pages.push(page);
    const wallet = await installAnvilWallet(page, claimant);
    await newPerson(page, `Sam ${NAME_TAG}`);
    await page.goto(`/earlier-grant${mine.fragment}`);
    await expect(page.getByTestId("claim-grant")).toHaveText(
      "Your grant: 2,500 Team Shares.",
      { timeout: 60_000 },
    );
    ok("the listed account sees its own grant: 2,500 Team Shares");
    await expect(page.getByTestId("claim-vesting")).toContainText(
      "They unlock evenly over 365 days counted from the day the project began, with no waiting period at the start.",
    );
    await expect(page.getByTestId("claim-taking-out")).toHaveText(
      "Taking Team Shares out pays only what the project holds above what backers put in. That can be nothing.",
    );
    await expect(page.getByTestId("claim-count")).toHaveText(
      "0 of 4 grants claimed.",
    );
    await expect(page.getByTestId("claim-fingerprint")).toHaveText(
      fingerprintLine(grantsOf(first.content)?.textHash as string),
    );
    ok(
      "the page names what the contract does, the count (a total, no names) and the text's fingerprint",
    );
    await expect(page.getByText(BANNER)).toHaveCount(1);
    ok("the banner is on the page once, word for word");
    const text = (await page.locator("body").textContent()) ?? "";
    check(
      !/1,000 Team Shares|\b40 Team Shares|\b12 Team Shares/.test(text),
      "no other row's amount is anywhere on the page",
    );
    const press = page.getByTestId("claim-press");
    await expect(press).toBeDisabled();
    await page.getByTestId("claim-tick").check();
    await expect(
      press,
      "ticking is not enough: the text must be opened",
    ).toBeDisabled();
    await page.getByTestId("claim-tick").uncheck();
    // The text opens in another tab, and is the text the fingerprint is of.
    const [popup] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByTestId("claim-read-text").click(),
    ]);
    await popup.waitForLoadState();
    check(
      (await popup.locator("body").textContent())?.includes(
        "An invented text for the test network",
      ) === true,
      "'Read the text' opens the text in another tab",
    );
    await popup.close();
    await expect(
      press,
      "opening the text is not enough: the box must be ticked",
    ).toBeDisabled();
    await page.getByTestId("claim-tick").check();
    await expect(press).toBeEnabled();
    ok("the claim is offered only once the text was opened and the box ticked");
    await atNarrowPhone(page, "the claim page", [
      "claim-grant",
      "claim-vesting",
      "claim-fingerprint",
      "claim-read-text",
      "claim-tick",
      "claim-press",
    ]);
    const promptsBefore = wallet.prompts;
    await press.click();
    await expect(page.getByTestId("claim-done")).toHaveText(
      "Claimed. Your Team Shares unlock over time.",
      { timeout: 60_000 },
    );
    same(wallet.prompts - promptsBefore, 1, "the claim asked the wallet once");

    // ── the chain, the contract's own record of the acceptance, and the server's record ───────────────────────────────
    check(
      await reads.earlierRowClaimed(read, claims, BigInt(mine.index)),
      "the row is claimed on the chain",
    );
    const ids = await reads.grantIdsOf(read, project.vester, claimant);
    const grants = await Promise.all(
      ids.map((id) => state.readGrant(read, project.vester, id)),
    );
    check(
      grants.some((g) => g.protectedGrant && g.total === BigInt(mine.amount)),
      "the account holds a protected grant of exactly its row's Team Shares",
    );
    const claimed = await waitForRecord(
      project.key,
      "the record counts the claim",
      (n) => grantsOf(n)?.claimedRows === 1,
    );
    same(
      grantsOf(claimed.content)?.claimedTotal,
      mine.amount,
      "the record's claimed total is the row's amount",
    );
    check(
      (
        claimed.content as unknown as {
          team: { grants: { member: string; kind: string }[] };
        }
      ).team.grants.some(
        (g) => g.member === claimant && g.kind === "protected",
      ),
      "the record lists the claimed grant as a protected grant, as any grant is listed",
    );
    plus(
      checkAgainstContracts(claimed.content, {}, true),
      `field-by-field checks of the record against the contracts, after a claim, at block ${claimed.content.asOf.block}`,
    );

    // ── an account with no row ──────────────────────────────────────────────────────────────────────────────────────────
    const other = await phone(browser);
    pages.push(other);
    await installAnvilWallet(other, outsider);
    await newPerson(other, `Oz ${NAME_TAG}`);
    await other.goto(`/earlier-grant${mine.fragment}`);
    await expect(other.getByTestId("claim-not-for-you")).toHaveText(
      "This link is not for the account you are using. Open it with the account it was made for.",
      { timeout: 60_000 },
    );
    await expect(other.getByTestId("claim-press")).toHaveCount(0);
    ok(
      "an account with no row, holding another's link, is told the link is not for it and is offered no press",
    );
    // Another account, the same row's proof, straight to the contract: refused, in the app's words.
    const error = await walletOf(outsider)
      .sendCalls(
        [
          pot.earlierClaimCall({
            contract: claims,
            index: BigInt(mine.index),
            amount: BigInt(mine.amount),
            proof: JSON.parse(
              Buffer.from(mine.fragment.slice(1), "base64url").toString("utf8"),
            ).proof,
            accepted: grantsOf(first.content)?.textHash as string,
          }),
        ],
        31337,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    check(
      error !== null,
      "the contract refuses a claim of another account's row",
    );
    same(
      potProblem(error, "earlier-claim"),
      "This grant is already claimed. Nothing changed.",
      "the refusal reads in the app's words (the row was claimed first)",
    );
    // The row of an unlisted account, with a row of someone else's list position it is not in: BadProof in words.
    const wrongRow = others[0];
    if (!wrongRow) throw new Error("the list has no other row");
    const badProof = await walletOf(outsider)
      .sendCalls(
        [
          pot.earlierClaimCall({
            contract: claims,
            index: BigInt(wrongRow.index),
            amount: BigInt(wrongRow.amount),
            proof: JSON.parse(
              Buffer.from(wrongRow.fragment.slice(1), "base64url").toString(
                "utf8",
              ),
            ).proof,
            accepted: grantsOf(first.content)?.textHash as string,
          }),
        ],
        31337,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    same(
      potProblem(badProof, "earlier-claim"),
      "This link is not for the account you are using. Nothing was claimed. Open it with the account it was made for.",
      "another account's row, sent by an account that is not in it, is refused in the app's words",
    );
    check(
      !(await reads.earlierRowClaimed(read, claims, BigInt(wrongRow.index))),
      "and that row is still unclaimed",
    );

    // ── the same row a second time ─────────────────────────────────────────────────────────────────────────────────────
    // The same address: a plain load, so the page reads the row again (a visit to the same address with the same part after # would
    // not load anything).
    await page.reload();
    await expect(page.getByTestId("claim-already")).toHaveText(
      "This grant is already claimed. You can see it in Your Shares.",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("claim-press")).toHaveCount(0);
    await expect(page.getByTestId("claim-count")).toHaveText(
      "1 of 4 grants claimed.",
    );
    ok(
      "opening the claimed row's link again says it is already claimed, and the count is one of four",
    );
  } finally {
    stopMiner();
    for (const page of pages) await page.context().close();
  }
});
