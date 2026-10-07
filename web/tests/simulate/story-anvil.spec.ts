import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { installAnvilWallet, pointChainAt } from "../helpers/anvil-wallet";
import { FOUNDER_NSEC, mockLaunchRelay } from "../helpers/funding-fixture";
import { CAST } from "./cast";
import type { Check } from "./invariants";
import {
  blockNumber,
  callReverts,
  invariantReadings,
  mine,
  readVaultWorld,
  sendFrom,
} from "./chain-world";
import { STORY } from "./scenes";
import {
  renderReport,
  reportHolds,
  runStory,
  stepKey,
  storyIssues,
} from "./story";
import {
  encodeFail,
  encodeOpenProposal,
  encodeVerify,
} from "../../src/features/launchpad/lib/proposal-vault-tx";

/**
 * Entry voice, played against a REAL chain (`scripts/web-vault-e2e.sh`).
 *
 * Spending vouchers on a proposal is the voice to enter — the mirror of
 * ragequit (plan §4). This scene moves money, so it is played here and not in
 * `story.spec.ts`, which is honest about covering the client world only.
 *
 * What is real: the chain, the `ProposalVault`, every transaction and its
 * receipt, the tax, the escrow, the refund. What is stubbed: the wallet
 * (Anvil's unlocked accounts) and the relay (the launch record that names the
 * vault).
 *
 * Opt-in: skipped unless the harness has built the world.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const VAULT = process.env.E2E_VAULT ?? "";
const PROPOSAL = process.env.E2E_PROPOSAL ?? "";
const BACKER = process.env.E2E_BACKER ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const TOKEN = process.env.E2E_TOKEN ?? "";
const TREASURY = process.env.E2E_TREASURY ?? "";
const BACKER_FUNDS = process.env.E2E_BACKER_FUNDS ?? "0";
/** Governance is Anvil account 0 here — the judge and the founder. */
const GOVERNANCE = process.env.E2E_TREASURY ?? "";
/** An outsider: no rights over the vault, which is the point of the step. */
const TROUBLEMAKER = process.env.E2E_TROUBLEMAKER ?? "";
/** The second proposal, opened by the settlement scene itself. */
const PROPOSAL_B = `0x${"bb".repeat(32)}`;
const CHECK_WORD = `0x${"ab".repeat(32)}`;
/** What the second proposal needs before its work may start. */
const PROPOSAL_B_MIN = 1000n;
const PRICE = BigInt(process.env.E2E_PRICE ?? "2");
const TAX_BPS = BigInt(process.env.E2E_TAX_BPS ?? "500");

const PLEDGE = 1000n;
const COMMIT = 200n;

/** The chain's own arithmetic, so the assertions follow the deployed settings. */
const tax = (COMMIT * TAX_BPS) / 10_000n;
const reserve = COMMIT - tax;
const escrowedTokens = (reserve * 10n ** 18n) / PRICE;

test.skip(
  !ANVIL_URL || !VAULT || !PROPOSAL || !BACKER,
  "set E2E_ANVIL_URL / E2E_VAULT / E2E_PROPOSAL / E2E_BACKER — scripts/web-vault-e2e.sh does",
);

const OUT_DIR = "test-results/simulate";

/**
 * The world this scene is played against: a chain that actually settles. The
 * readings are computed from real state — the four equalities in
 * `chain-world.ts` — so a tick here means the chain said so.
 */
const chainReadings = async (): Promise<Check[]> =>
  invariantReadings(
    await readVaultWorld(ANVIL_URL, {
      vault: VAULT,
      currency: CURRENCY,
      token: TOKEN,
      backer: BACKER,
      treasury: TREASURY,
      proposalIds: [PROPOSAL, PROPOSAL_B],
      initialCurrency: BigInt(BACKER_FUNDS),
    }),
  );

const vault = (page: Page) => page.getByTestId("proposal-vault");
const vouchers = async (page: Page) => {
  const text = await page.getByTestId("vault-vouchers").innerText();
  return Number(text.replace(/[^0-9]/g, ""));
};

/**
 * The play, in the order `runStory` walks the chain scenes. Each entry is what
 * one step does in the browser and the screenshot it leaves behind.
 */
const PLAYS: Array<(page: Page) => Promise<string>> = [
  // 1. Pledge: vouchers appear, one per unit.
  async (page) => {
    await page.goto("/launchpad");
    await page
      .locator('[data-testid="launch-card"]')
      .filter({ hasText: "Aurora" })
      .getByTestId("launch-card-title")
      .click();
    await expect(vault(page)).toBeVisible();

    await page.getByTestId("pledge-amount").fill(PLEDGE.toString());
    await page.getByTestId("pledge").click();
    await expect
      .poll(async () => vouchers(page), { timeout: 20_000 })
      .toBe(Number(PLEDGE));
    return "10-pledge-makes-vouchers";
  },

  // 2. Back a proposal: the tax leaves, the reserve grows, the tokens escrow.
  async (page) => {
    await page.getByTestId("commit-amount").fill(COMMIT.toString());
    // The preview is the chain's own arithmetic: the tax leaves, the rest is
    // reserved, and tokens are priced off the reserve.
    await expect(page.getByTestId("commit-preview")).toContainText(
      `${reserve} to the reserve`,
    );
    await page.getByTestId("back-proposal").click();
    await expect(page.getByTestId("own-escrowed")).toContainText(
      escrowedTokens.toString(),
      { timeout: 20_000 },
    );
    return "11-backing-moves-money";
  },

  // 3. The voice is real, and unspent vouchers still buy none.
  async (page) => {
    const weight = await page.getByTestId("own-weight").innerText();
    const amount = BigInt(weight.replace(/[^0-9]/g, ""));
    expect(
      amount >= escrowedTokens,
      "a commitment earns at least its stake back",
    ).toBe(true);
    // Only what was not spent is still unspent; the panel keeps the two apart
    // because only the committed part counts as voice.
    await expect
      .poll(async () => vouchers(page), { timeout: 20_000 })
      .toBe(Number(PLEDGE - COMMIT));
    return "12-voice-follows-the-money";
  },

  // 4. Taking unspent back returns only the unspent part.
  async (page) => {
    await page.getByTestId("refund-vouchers").click();
    await expect.poll(async () => vouchers(page), { timeout: 20_000 }).toBe(0);
    // What was committed to the proposal stays with it.
    await expect(page.getByTestId("own-escrowed")).toContainText(
      escrowedTokens.toString(),
    );
    return "13-only-the-unspent-part-returns";
  },

  // ---- settlement ----

  // 5. The judge rules on the check that was written when the proposal opened.
  async (page) => {
    await sendFrom(ANVIL_URL, GOVERNANCE, VAULT, encodeVerify(PROPOSAL));
    // The judge acts outside the page, so the panel has to be re-read: it
    // refreshes on its own actions and on nothing else.
    await page.reload();
    await expect
      .poll(
        async () =>
          (await page.getByTestId("funding-proposal").first().innerText()) ??
          "",
        { timeout: 20_000 },
      )
      .toContain("Milestone verified");
    return "14-the-judge-rules";
  },

  // 6. Escrow hands over exactly what it held.
  async (page) => {
    const row = page.getByTestId("funding-proposal").first();
    await row.getByTestId("claim-tokens").click();
    await expect(row.getByTestId("own-escrowed")).toHaveCount(0, {
      timeout: 20_000,
    });
    return "15-the-escrow-releases";
  },

  // 7. A second proposal nobody funds to its minimum.
  async (page) => {
    await sendFrom(
      ANVIL_URL,
      GOVERNANCE,
      VAULT,
      encodeOpenProposal(
        PROPOSAL_B,
        PROPOSAL_B_MIN,
        10_000n,
        BigInt((await blockNumber(ANVIL_URL)) + 5),
        CHECK_WORD,
      ),
    );
    // The panel lists what the chain has opened; reload to see the new one.
    await page.reload();
    await expect(page.getByTestId("funding-proposal")).toHaveCount(2);
    // The first proposal is already settled, so it is the second row that
    // still offers a backing box — scope to the row, not to the test id alone.
    // The backer took their unspent vouchers back earlier, so backing this
    // one means pledging again first. That is the honest order of events.
    await page.getByTestId("pledge-amount").fill(COMMIT.toString());
    await page.getByTestId("pledge").click();
    await expect
      .poll(async () => vouchers(page), { timeout: 20_000 })
      .toBe(Number(COMMIT));

    const row = page.getByTestId("funding-proposal").nth(1);
    await row.getByTestId("commit-amount").fill(COMMIT.toString());
    await row.getByTestId("back-proposal").click();
    await expect
      .poll(async () => row.innerText(), { timeout: 20_000 })
      // The progress line counts what reached the reserve, after the tax.
      .toContain(`${reserve} of ${PROPOSAL_B_MIN} needed`);
    return "16-below-the-minimum";
  },

  // 8. A live proposal is not an outsider's to close.
  async (page) => {
    const refuses = await callReverts(
      ANVIL_URL,
      TROUBLEMAKER,
      VAULT,
      encodeFail(PROPOSAL_B),
    );
    expect(
      refuses,
      "an outsider must not be able to close a live proposal",
    ).toBe(true);
    // And the panel still treats it as open for backing.
    await expect(
      page.getByTestId("funding-proposal").nth(1).getByTestId("back-proposal"),
    ).toBeVisible();
    return "17-nobody-closes-it-early";
  },

  // 9. The deadline passes below the minimum, and the money comes back.
  async (page) => {
    await mine(ANVIL_URL, 10);
    await sendFrom(ANVIL_URL, GOVERNANCE, VAULT, encodeFail(PROPOSAL_B));
    await page.reload();
    const row = page.getByTestId("funding-proposal").nth(1);
    await expect(row.getByTestId("refund-position")).toBeVisible({
      timeout: 20_000,
    });
    await row.getByTestId("refund-position").click();
    await expect
      .poll(async () => row.innerText(), { timeout: 20_000 })
      .toContain("Did not go ahead");
    return "18-a-refund-not-a-slash";
  },
];

test("entry voice, played on the chain", async ({ page }) => {
  expect(storyIssues(STORY, CAST), "the story has structural issues").toEqual(
    [],
  );
  const expected = STORY.scenes
    .filter((scene) => scene.world === "chain")
    .flatMap((scene) => scene.steps.map((step) => step.does));
  expect(PLAYS.length, "the plays are bound to these exact steps").toEqual(
    expected.length,
  );

  await mockLaunchRelay(page, { vault: VAULT });
  await pointChainAt(page, ANVIL_URL);
  await installAnvilWallet(page, BACKER, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  mkdirSync(OUT_DIR, { recursive: true });

  const shots: string[] = [];
  // The readings have to be taken as each step lands. Reading the world once at
  // the end would print the final state against every step — a report that
  // looks measured and is not.
  const recorded = new Map<string, Check[]>();
  // The chain scenes' steps, in the order `runStory` will walk them.
  const keys = STORY.scenes
    .filter((scene) => scene.world === "chain")
    .flatMap((scene) => scene.steps.map((_, index) => stepKey(scene, index)));
  expect(keys.length, "every chain step has a play").toEqual(PLAYS.length);

  for (let index = 0; index < PLAYS.length; index += 1) {
    const name = await PLAYS[index](page);
    await page.screenshot({
      path: join(OUT_DIR, `${name}.png`),
      fullPage: true,
    });
    shots.push(name);
    recorded.set(keys[index], await chainReadings());
  }

  const report = await runStory(
    STORY,
    (_step, key) => recorded.get(key) ?? [],
    "chain",
  );
  report.entries.forEach((entry, index) => {
    entry.artifact = `${shots[index]}.png`;
  });
  writeFileSync(
    join(OUT_DIR, "timeline-chain.md"),
    `${renderReport(report)}\n`,
  );
  expect(reportHolds(report), "the timeline reports a failure").toBe(true);
});
