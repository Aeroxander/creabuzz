import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";

/**
 * The Markets page in the standard build, which names no price service: it lists the projects whose raise succeeded,
 * says plainly that prices are not available, and links each project to its track record. The page with prices is
 * `markets-prices.spec.ts` (needs a build pointed at a price service: `scripts/web-markets-e2e.sh`).
 */

const FOUNDER = "a".repeat(64);
const TOKEN = "0x1111111111111111111111111111111111111111";
const CURRENCY = "0x2222222222222222222222222222222222222222";

function launch(id: string, name: string, stage: string, createdAt: number) {
  return {
    id: `record-${id}`,
    pubkey: FOUNDER,
    created_at: createdAt,
    kind: 37001,
    tags: [
      ["d", id],
      ["name", name],
      ["t", "dao-launchpad"],
      ["chain", "31337"],
      ["token", TOKEN],
    ],
    content: JSON.stringify({
      pitch: `${name} pitch`,
      stage,
      currency: CURRENCY,
      tokenPlan: { mode: "dao", name, symbol: "TKN", supply: "1000000" },
    }),
    sig: "sig",
  };
}

async function open(page: import("@playwright/test").Page, path: string) {
  const relay = createMockRelay();
  relay.seed(launch("aurora", "Aurora", "graduated", 300));
  relay.seed(launch("beacon", "Beacon", "graduated", 200));
  relay.seed(launch("cygnus", "Cygnus", "live", 400));
  await relay.install(page);
  await page.goto(path);
}

test("only projects whose raise succeeded are listed, newest first, each with a link to its track record", async ({
  page,
}) => {
  await open(page, "/markets");
  await expect(page.getByTestId("market-row")).toHaveCount(2, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("market-name")).toHaveText([
    "Aurora",
    "Beacon",
  ]);
  // A project still raising is not on the market.
  await expect(page.getByText("Cygnus")).toHaveCount(0);
  await expect(page.getByTestId("market-record").first()).toHaveAttribute(
    "href",
    /\/launchpad\/aurora\?.*tab=record/,
  );
});

test("without a price service the page says so and shows no prices, instead of zeros", async ({
  page,
}) => {
  await open(page, "/markets");
  await expect(page.getByTestId("markets-no-service")).toContainText(
    "not connected to a price service",
  );
  await expect(page.getByTestId("market-price")).toHaveCount(0);
  await expect(page.getByTestId("market-untraded").first()).toHaveText(
    "No price service",
  );
});

test("Launches links to Markets and keeps its tab lit there", async ({
  page,
}) => {
  await open(page, "/launchpad");
  await page.getByTestId("open-markets").click();
  await expect(page).toHaveURL(/\/markets$/);
  await expect(page.getByTestId("app-nav-launches")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Launches" }).first().click();
  await expect(page).toHaveURL(/\/launchpad/);
});

test("with nothing graduated, the page says what puts a project here", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launch("cygnus", "Cygnus", "live", 400));
  await relay.install(page);
  await page.goto("/markets");
  await expect(page.getByTestId("markets-empty")).toContainText(
    "Nothing is on the market yet",
  );
});

test("the markets page is accessible", async ({ page }) => {
  await open(page, "/markets");
  await expect(page.getByTestId("market-row")).toHaveCount(2, {
    timeout: 20_000,
  });
  await expectAccessible(page, "markets");
});

test("the markets page fits a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, "/markets");
  await expect(page.getByTestId("market-row")).toHaveCount(2, {
    timeout: 20_000,
  });
  await expectNoSidewaysScroll(page, "markets on a phone");
});
