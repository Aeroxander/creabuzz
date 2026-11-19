import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { BACKER_EVM, FOUNDER_EVM } from "../helpers/numbers-fixture";
import { addressWord, word } from "./helpers/chain-wallet";
import {
  FOUNDER_KEY,
  MATE_KEY,
  openTeam,
  PAIR_READS,
  seedTeam,
  withSale,
} from "./helpers/team-world";
import { createMockRelay } from "./mock-relay";

/**
 * Phone screenshots of milestone 7's screens at 390x844 for review: `pnpm screens`. They land in test-results/screens/
 * (not committed). Each is taken from its own page, so no two can be the same pixels; `shasum -a 256` over the folder
 * tells them apart.
 */
const OUT = path.resolve(process.cwd(), "test-results/screens");
mkdirSync(OUT, { recursive: true });

async function shoot(page: Page, name: string) {
  await waitForAnimations(page);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    caret: "hide",
    animations: "disabled",
  });
}

test.describe.configure({ mode: "serial" });

test("team: the second seat and the hand-over sheet", async ({ page }) => {
  const relay = createMockRelay();
  seedTeam(relay, "backed");
  await openTeam(page, relay, FOUNDER_KEY, {
    account: FOUNDER_EVM,
    reads: {
      "pairAddress(bytes32,address,address)": `0x${addressWord("0x9a0000000000000000000000000000000000a1b2")}`,
    },
  });
  await page.getByTestId("second-seat").waitFor({ timeout: 20_000 });
  await shoot(page, "m7-01-second-seat");
  await page.getByTestId("tab-money").click();
  await page.getByTestId("hand-over").click();
  await page.getByTestId("hand-over-sheet").waitFor();
  await page.waitForTimeout(400);
  await shoot(page, "m7-02-hand-over");
});

test("team: the Pair's card", async ({ page }) => {
  const relay = createMockRelay();
  seedTeam(relay, "team");
  await openTeam(page, relay, FOUNDER_KEY, {
    account: FOUNDER_EVM,
    reads: PAIR_READS,
  });
  await page.getByTestId("pair-card").waitFor({ timeout: 20_000 });
  await shoot(page, "m7-03-pair-card");
});

test("market: the bid box and what to know before bidding", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedTeam(relay, "team", withSale(false));
  await openTeam(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    block: 2_000,
    reads: PAIR_READS,
  });
  await page.getByTestId("bid-box").waitFor({ timeout: 20_000 });
  await shoot(page, "m7-04-bid-box");
  await page.getByTestId("tab-money").click();
  await page.getByTestId("auction-disclosure").waitFor({ timeout: 20_000 });
  await shoot(page, "m7-05-before-you-bid");
});

test("market: the pool, the floor line and handing back", async ({ page }) => {
  const relay = createMockRelay();
  seedTeam(relay, "team", withSale(true));
  await openTeam(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    block: 9_000,
    reads: {
      "melting()": `0x${word(60_000_000_000n)}`,
      "meltRemaining()": `0x${word(365n * 86_400n)}`,
      "countingSupply()": `0x${word(250_000_000n * 10n ** 18n)}`,
      "totalSupply()": `0x${word(10n ** 27n)}`,
      "saleClosed()": `0x${word(1)}`,
    },
  });
  await page.getByTestId("hand-back").waitFor({ timeout: 20_000 });
  await shoot(page, "m7-06-pool");
  await page.getByTestId("hand-back").click();
  await page.getByTestId("hand-back-amount").fill("1000");
  await page.waitForTimeout(400);
  await shoot(page, "m7-07-hand-back");
  await page.keyboard.press("Escape");
  await page.getByTestId("tab-money").click();
  await page.getByTestId("floor-line").waitFor({ timeout: 20_000 });
  await shoot(page, "m7-08-floor-line");
});
