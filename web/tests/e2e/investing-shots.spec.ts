import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  boughtEvent,
  FIXTURE,
  installBackingChain,
  POOL_DEFAULTS,
  type PoolFixture,
  postedEvent,
  resolvedEvent,
} from "../helpers/fake-backing-chain";
import { PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
} from "./helpers/project-world";

/**
 * Screenshots of the investing surfaces, for looking at: the Backing block in each state at a desktop and a phone width,
 * at twice the pixel density. Only when INVEST_SHOTS names a folder; otherwise it skips. Run it against the switch-on build
 * with `scripts/web-investing-mock-e2e.sh` (ONLY=on, INVEST_SHOTS=<folder>, -g shots).
 */

const DIR = process.env.INVEST_SHOTS;
test.skip(
  !DIR || process.env.E2E_INVESTING_BUILD !== "on",
  "set INVEST_SHOTS to a folder and run against the switch-on build",
);
test.use({ deviceScaleFactor: 2 });

const FOUNDER_KEY = "c1".repeat(32);
const VISITOR_KEY = "c2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const COORD = coordOf(FOUNDER, "docs-commons");
const ONE = 10n ** 6n;
const UNIT = 10n ** 18n;
const WIDTHS = [
  { name: "1280", width: 1280, height: 900 },
  { name: "390", width: PHONE.width, height: PHONE.height },
];

async function shoot(
  page: Page,
  options: {
    name: string;
    pool: PoolFixture | null;
    as: "founder" | "visitor";
    wallet: string;
    before?: (page: Page) => Promise<void>;
    /** Another page than the project's, and the element on it to photograph. */
    path?: string;
    target?: string;
    ready?: string;
  },
) {
  const relay = createMockRelay();
  relay.seed(
    event(
      0,
      FOUNDER,
      { name: "Fran Founder", display_name: "Fran Founder" },
      [],
      now() - 90 * DAY,
    ),
  );
  relay.seed(
    projectRecord(FOUNDER, "docs-commons", "Docs Commons", now() - 60 * DAY, {
      content: {
        pitch: "Open docs for everyone, written by the people who use them.",
        stage: "graduated",
        funding: {
          stance: "not-raising",
          seeking: ["contributors"],
          path: "contributors",
        },
        tokenPlan: {
          mode: "dao",
          name: "Docs Commons",
          symbol: "DOCS",
          supply: "100000",
        },
      },
      tags: [
        ["chain", String(FIXTURE.chainId)],
        ["treasury", FIXTURE.dao],
        ["token", `0x${"5e".repeat(20)}`],
      ],
    }),
  );
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Sign-up is live", body: "" },
      [["a", COORD]],
      now() - 3 * DAY,
    ),
  );
  await install(
    page,
    relay,
    options.as === "founder" ? FOUNDER_KEY : VISITOR_KEY,
  );
  await installBackingChain(page, {
    pool: options.pool,
    wallet: options.wallet,
  });
  mkdirSync(DIR as string, { recursive: true });
  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(
      options.path ?? `/launchpad/docs-commons?author=${FOUNDER}`,
    );
    const block = page.getByTestId(options.target ?? "backing");
    await expect(block).toBeVisible({ timeout: 30_000 });
    await expect(
      block.getByTestId(options.ready ?? "backing-state").first(),
    ).toBeVisible({ timeout: 30_000 });
    // Let the reads and the animations settle, then keep the whole block in view.
    await page.waitForTimeout(800);
    if (options.before) await options.before(page);
    // The stubbed server has no terms to check: its notice is not part of what is being looked at.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll("div, section, aside")) {
        if (
          node.children.length < 4 &&
          node.textContent?.includes("could not check whether the terms")
        )
          (node as HTMLElement).style.display = "none";
      }
    });
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.finish();
    });
    await block.screenshot({
      path: join(DIR as string, `${options.name}-${size.name}.png`),
    });
  }
}

const live: PoolFixture = {
  ...POOL_DEFAULTS,
  holderUnits: 4_000_000n * UNIT,
  holderSellValue: 90n * ONE,
  holderEscrow: 10n * ONE,
  events: [
    boughtEvent(FIXTURE.backerWallet, 100n * ONE, 1n, 10),
    boughtEvent(FIXTURE.founderWallet, 50n * ONE, 2n, 11),
    postedEvent(1n, "e".padEnd(64, "1"), FIXTURE.founderWallet, 20),
    resolvedEvent(1n, true, 40n * ONE, 21),
  ],
};

test("none: a visitor and a founder", async ({ page }) => {
  await shoot(page, {
    name: "none-visitor",
    pool: null,
    as: "visitor",
    wallet: FIXTURE.backerWallet,
  });
});
test("none: the founder", async ({ page }) => {
  await shoot(page, {
    name: "none-founder",
    pool: null,
    as: "founder",
    wallet: FIXTURE.founderWallet,
    before: async (p) => {
      await p.getByTestId("backing-open-round").click();
    },
  });
});
test("live: a backer with a position, and the buy form open", async ({
  page,
}) => {
  await shoot(page, {
    name: "live",
    pool: live,
    as: "visitor",
    wallet: FIXTURE.backerWallet,
  });
});
test("live: the buy form", async ({ page }) => {
  await shoot(page, {
    name: "live-buy",
    pool: live,
    as: "visitor",
    wallet: FIXTURE.backerWallet,
    before: async (p) => {
      await p.getByTestId("backing-back").click();
      await p.getByTestId("backing-amount").fill("10");
      await expect(p.getByTestId("backing-plan")).toContainText(
        "You get about",
        { timeout: 15_000 },
      );
    },
  });
});
test("round: bidding, with the bid form open", async ({ page }) => {
  await shoot(page, {
    name: "round",
    pool: { ...POOL_DEFAULTS, phase: "waiting", roundBlocksLeft: 30_000 },
    as: "visitor",
    wallet: FIXTURE.backerWallet,
    before: async (p) => {
      await p.getByTestId("backing-bid").click();
    },
  });
});
test("leaving: a window is open and the backer may leave", async ({ page }) => {
  await shoot(page, {
    name: "leaving",
    pool: {
      ...live,
      windowEndsIn: 5 * DAY,
      holderCanLeave: true,
      holderLeaveValue: 99n * ONE,
      events: [
        ...live.events.slice(0, 2),
        postedEvent(2n, "e".padEnd(64, "1"), FIXTURE.founderWallet, 30),
      ],
    },
    as: "visitor",
    wallet: FIXTURE.backerWallet,
    before: async (p) => {
      await p.getByTestId("backing-leave").click();
      await expect(p.getByTestId("backing-leave-plan")).toContainText(
        "You get about",
        { timeout: 15_000 },
      );
    },
  });
});
test("failed and closed", async ({ page }) => {
  await shoot(page, {
    name: "failed",
    pool: { ...POOL_DEFAULTS, phase: "failed" },
    as: "visitor",
    wallet: FIXTURE.backerWallet,
  });
  await shoot(page, {
    name: "closed",
    pool: { ...live, phase: "abandoned" },
    as: "visitor",
    wallet: FIXTURE.backerWallet,
  });
});

test("Home's feed and what you back", async ({ page }) => {
  await shoot(page, {
    name: "home-feed",
    pool: live,
    as: "visitor",
    wallet: FIXTURE.backerWallet,
    path: "/?tab=updates",
    target: "record-feed",
    ready: "backing-feed-card",
  });
  await shoot(page, {
    name: "you-back",
    pool: {
      ...live,
      windowEndsIn: DAY,
      holderCanLeave: true,
      holderLeaveValue: 99n * ONE,
    },
    as: "visitor",
    wallet: FIXTURE.backerWallet,
    path: "/portfolio",
    target: "projects-you-back",
    ready: "back-position",
  });
});
