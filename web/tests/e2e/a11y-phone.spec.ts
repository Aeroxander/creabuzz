import { test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";

/**
 * The screens a newcomer meets, on a phone, in light and dark. Phone-only things (the bottom tab bar, small text) fail axe
 * differently from the wide layout, which the other accessibility specs cover.
 */

const NSEC = "aa".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

const PAGES: [string, string][] = [
  ["Home", "/"],
  ["Start", "/start"],
  ["Discover", "/discover"],
  ["Launchpad", "/launchpad"],
  ["Project board", "/projects"],
  ["Portfolio", "/portfolio"],
  ["Messages", "/social/messages"],
  ["Explore", "/social/explore"],
  ["Communities", "/c"],
  ["Your profile", `/u/${ME}`],
];

for (const scheme of ["light", "dark"] as const) {
  test(`the top-level screens are accessible and fit on a phone (${scheme})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const relay = createMockRelay();
    await relay.install(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
    }, NSEC);
    await page.setViewportSize(PHONE);
    for (const [name, path] of PAGES) {
      await page.goto(path);
      await page.getByTestId("app-nav").waitFor({ timeout: 20_000 });
      // Let the first queries settle so a skeleton is not what is measured.
      await page.waitForTimeout(600);
      await expectNoSidewaysScroll(page, `${name}, ${scheme}`);
      await expectAccessible(page, `${name} on a phone, ${scheme}`);
    }
  });
}
