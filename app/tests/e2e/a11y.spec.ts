import { type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";
import { RELAY } from "./helpers/money-world";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/world";

/**
 * axe on every screen of the app, at 390 and 360 wide, in light and dark, with investing on (so the Money tab of a project
 * that is not on the network yet is measured too; the money screens and their sheets have their own run, `pot-a11y.spec.ts`).
 * Fails on serious and critical findings; also checks nothing scrolls sideways.
 */

const FOUNDER_KEY = "b1".repeat(32);
const READER_KEY = "b2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const READER = pubkeyOf(READER_KEY);
const COORD = coordOf(FOUNDER, "lantern");
const PROJECT = projectLink(FOUNDER, "lantern");

function seed(relay: Relay) {
  relay.seed(profile(FOUNDER, "Fay Founder", "Building lamps that last."));
  relay.seed(profile(READER, "Rae Reader"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
    ),
  );
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Week 1", body: "Built the first lamp and gave it to a stall." },
      [["a", COORD]],
      now() - DAY,
    ),
  );
}

/** Let reads settle so a skeleton is not what is measured, then measure. */
async function check(page: Page, surface: string) {
  await page.waitForTimeout(500);
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

    test(`a reader's screens are accessible (${label})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      const relay = createMockRelay();
      seed(relay);
      await install(page, relay, READER_KEY, {
        investing: true,
        relaySelf: RELAY,
      });

      await page.goto("/");
      await page
        .getByTestId("project-card")
        .first()
        .waitFor({ timeout: 20_000 });
      await check(page, `Home, ${label}`);

      await page.goto(PROJECT);
      await page.getByTestId("project-name").waitFor({ timeout: 20_000 });
      await check(page, `Project, Updates, ${label}`);
      for (const tab of ["people", "money"]) {
        await page.getByTestId(`tab-${tab}`).click();
        await check(page, `Project, ${tab}, ${label}`);
      }

      await page.goto("/you");
      await page.getByTestId("tab-bar").waitFor({ timeout: 20_000 });
      await check(page, `You, ${label}`);

      for (const [name, path] of [["Start", "/start"]] as const) {
        await page.goto(path);
        await page.locator("main").waitFor({ timeout: 20_000 });
        await check(page, `${name}, ${label}`);
      }
    });

    test(`a founder's screens are accessible (${label})`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      const relay = createMockRelay();
      seed(relay);
      await install(page, relay, FOUNDER_KEY, {
        investing: true,
        relaySelf: RELAY,
      });
      await page.goto("/week");
      await page.getByTestId("week-open").waitFor({ timeout: 20_000 });
      await check(page, `This week, ${label}`);
      await page.getByTestId("week-open").click();
      await page.getByTestId("weekly-sheet").waitFor();
      await check(page, `Weekly update sheet, ${label}`);
    });

    test(`signed out, Home and sign-up are accessible (${label})`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      const relay = createMockRelay();
      seed(relay);
      await install(page, relay, null, {
        investing: true,
        relaySelf: RELAY,
        policy: {
          policy: {
            version: "v1",
            terms_markdown: "# Terms\n\nBe kind.",
            privacy_markdown: "# Privacy",
            age_attestation_required: true,
          },
        },
      });
      await page.goto("/");
      await page.getByTestId("home-welcome").waitFor({ timeout: 20_000 });
      await check(page, `Home signed out, ${label}`);
      await page.goto("/welcome");
      await page.locator("main").waitFor({ timeout: 20_000 });
      await check(page, `Sign-up, ${label}`);
      await page.goto("/you");
      await page.getByTestId("you-signed-out").waitFor({ timeout: 20_000 });
      await check(page, `You signed out, ${label}`);
    });
  }
