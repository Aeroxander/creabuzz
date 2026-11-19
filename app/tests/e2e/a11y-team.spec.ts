import { type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { BACKER_EVM, FOUNDER_EVM } from "../helpers/numbers-fixture";
import { addressWord, word } from "./helpers/chain-wallet";
import {
  FOUNDER_KEY,
  MATE_KEY,
  openTeam,
  PAIR,
  PAIR_READS,
  seedTeam,
  withSale,
} from "./helpers/team-world";
import { createMockRelay } from "./mock-relay";

/**
 * axe on Team's screens and sheets (milestone 7), at 390 and 360 wide, light and dark, as `a11y.spec.ts` does for the
 * rest of the app: the second seat (offer and accept), the Pair's card, Give Shares, hand over and wind down, and the
 * market's (the bid box and sheet, the disclosure before bidding, the pool with its depth, Hand back, the floor line).
 * Serious and critical findings fail; nothing may scroll sideways.
 */

async function check(page: Page, surface: string) {
  await page.waitForTimeout(400);
  await expectNoSidewaysScroll(page, surface);
  await expectAccessible(page, surface);
}

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

for (const size of WIDTHS)
  for (const scheme of ["dark", "light"] as const) {
    const label = `${size.width}, ${scheme}`;

    test(`Team's screens are accessible (${label})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      let relay = createMockRelay();
      seedTeam(relay, "backed");
      await openTeam(page, relay, FOUNDER_KEY, {
        account: FOUNDER_EVM,
        reads: {
          "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
        },
      });
      await page.getByTestId("second-seat").waitFor({ timeout: 20_000 });
      await check(page, `Add a second person, ${label}`);
      await page.getByTestId("offer-seat").click();
      await page.getByTestId("offer-seat-sheet").waitFor();
      await check(page, `Offer sheet, ${label}`);
      await page.keyboard.press("Escape");
      await page.getByTestId("tab-money").click();
      await page.getByTestId("runner-card").waitFor({ timeout: 20_000 });
      await check(page, `Money with the runner seat, ${label}`);
      await page.getByTestId("wind-down").click();
      await page.getByTestId("wind-down-sheet").waitFor();
      await check(page, `Wind down sheet, ${label}`);
      await page.keyboard.press("Escape");
      await page.getByTestId("hand-over").click();
      await page.getByTestId("hand-over-sheet").waitFor();
      await check(page, `Hand over sheet, ${label}`);
      await page.keyboard.press("Escape");

      relay = createMockRelay();
      seedTeam(relay, "backed");
      const second = await page.context().newPage();
      await second.setViewportSize(size);
      await second.emulateMedia({ colorScheme: scheme });
      await openTeam(second, relay, MATE_KEY, {
        account: BACKER_EVM,
        reads: {
          "pendingRunner()": `0x${addressWord(PAIR)}`,
          "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
        },
      });
      await second.getByTestId("seat-offer").waitFor({ timeout: 20_000 });
      await check(second, `Seat offered, ${label}`);
      await second.getByTestId("seat-accept").click();
      await second.getByTestId("seat-sheet").waitFor();
      await check(second, `Accept sheet, ${label}`);
      await second.close();

      relay = createMockRelay();
      seedTeam(relay, "team");
      const pair = await page.context().newPage();
      await pair.setViewportSize(size);
      await pair.emulateMedia({ colorScheme: scheme });
      await openTeam(pair, relay, FOUNDER_KEY, {
        account: FOUNDER_EVM,
        reads: PAIR_READS,
      });
      await pair.getByTestId("pair-card").waitFor({ timeout: 20_000 });
      await check(pair, `The Pair's card, ${label}`);
      await pair.getByTestId("tab-people").click();
      await pair.getByTestId("give-shares").click();
      await pair.getByTestId("give-choice-1").click();
      await pair.getByTestId("give-review").waitFor();
      await check(pair, `Give Shares sheet, ${label}`);
      await pair.close();
    });
  }

for (const size of WIDTHS)
  for (const scheme of ["dark", "light"] as const) {
    const label = `${size.width}, ${scheme}`;

    test(`the market's screens are accessible (${label})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      let relay = createMockRelay();
      seedTeam(relay, "team", withSale(false));
      await openTeam(page, relay, MATE_KEY, {
        account: BACKER_EVM,
        block: 2_000,
        reads: PAIR_READS,
      });
      await page.getByTestId("bid-box").waitFor({ timeout: 20_000 });
      await check(page, `Bid box, ${label}`);
      await page.getByTestId("bid-amount").fill("250");
      await page.getByTestId("bid-review").click();
      await page.getByTestId("bid-sheet").waitFor();
      await check(page, `Bid sheet, ${label}`);
      await page.keyboard.press("Escape");
      await page.getByTestId("tab-money").click();
      await page.getByTestId("auction-disclosure").waitFor({ timeout: 20_000 });
      await check(page, `Before you bid, ${label}`);

      relay = createMockRelay();
      seedTeam(relay, "team", withSale(true));
      const pool = await page.context().newPage();
      await pool.setViewportSize(size);
      await pool.emulateMedia({ colorScheme: scheme });
      await openTeam(pool, relay, MATE_KEY, {
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
      await pool.getByTestId("hand-back").waitFor({ timeout: 20_000 });
      await check(pool, `The pool, ${label}`);
      await pool.getByTestId("hand-back").click();
      await pool.getByTestId("hand-back-amount").fill("1000");
      await check(pool, `Hand back sheet, ${label}`);
      await pool.keyboard.press("Escape");
      await pool.getByTestId("tab-money").click();
      await pool.getByTestId("floor-line").waitFor({ timeout: 20_000 });
      await check(pool, `The floor line, ${label}`);
      await pool.close();
    });
  }
