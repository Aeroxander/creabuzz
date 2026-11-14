import { expect, type Page } from "@playwright/test";

/** A phone-sized viewport: the width most people meet the app at. */
export const PHONE = { width: 390, height: 844 };

/**
 * Fails when the page scrolls sideways: the failure mode behind an "unreadable sliver". `surface` names what was on
 * screen, so a failure says which screen overflowed.
 */
export async function expectNoSidewaysScroll(page: Page, surface: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${surface}: the page scrolls sideways (${scrollWidth}px wide in a ${clientWidth}px window)`,
  ).toBeLessThanOrEqual(clientWidth);
}
