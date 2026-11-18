import { type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { BACKER_EVM, FOUNDER_EVM } from "../helpers/numbers-fixture";
import { addressWord } from "./helpers/chain-wallet";
import {
  FOUNDER_KEY,
  MATE_KEY,
  openTeam,
  PAIR,
  PAIR_READS,
  seedTeam,
} from "./helpers/team-world";
import { createMockRelay } from "./mock-relay";

/**
 * axe on Team's screens and sheets (milestone 7), at 390 and 360 wide, light and dark, as `a11y.spec.ts` does for the
 * rest of the app: the second seat (offer and accept), the Pair's card, Give Shares, hand over and wind down. Serious
 * and critical findings fail; nothing may scroll sideways.
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
