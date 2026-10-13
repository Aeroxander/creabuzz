import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * The Markets page with prices. Opt-in: the price service's address is baked into the build, so
 * `scripts/web-markets-e2e.sh` builds the web app pointed at a stand-in service address and runs this spec. The service
 * itself is answered here, so the spec checks what the page does with real-shaped answers: orientation of the pool, the
 * move over the last day, the volume, the order, and the honest "not traded yet".
 */

const SERVICE = process.env.E2E_PRICE_SERVICE ?? "";
const CURRENCY = "0x2222222222222222222222222222222222222222";
// Aurora's Shares sort before the currency (token0); Beacon's sort after it (the currency is token0).
const AURORA = "0x1111111111111111111111111111111111111111";
const BEACON = "0x3333333333333333333333333333333333333333";
const CYGNUS = "0x4444444444444444444444444444444444444444";
const AURORA_POOL = `0x${"a".repeat(64)}`;
const BEACON_POOL = `0x${"b".repeat(64)}`;
const FOUNDER = "a".repeat(64);

test.skip(
  !SERVICE,
  "set E2E_PRICE_SERVICE (scripts/web-markets-e2e.sh builds and runs this)",
);

function launch(id: string, name: string, token: string, createdAt: number) {
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
      ["token", token],
    ],
    content: JSON.stringify({
      pitch: `${name} pitch`,
      stage: "graduated",
      currency: CURRENCY,
      tokenPlan: { mode: "dao", name, symbol: "TKN", supply: "1000000" },
    }),
    sig: "sig",
  };
}

const HOUR = 3600;
const hourStart = (hoursAgo: number) =>
  Math.floor(Date.now() / 1000 / HOUR) * HOUR - hoursAgo * HOUR;

/** A candle for a pool where the Shares are token0: the price is currency per Share in base units (6 decimals / 18). */
function sharesFirst(
  hoursAgo: number,
  open: number,
  close: number,
  currencyVolume: number,
) {
  const raw = (price: number) => price * 1e-12;
  return {
    start: hourStart(hoursAgo),
    open: raw(open),
    high: raw(Math.max(open, close)),
    low: raw(Math.min(open, close)),
    close: raw(close),
    volume0: "1000000000000000000",
    volume1: String(Math.round(currencyVolume * 1e6)),
    trades: 2,
  };
}

/** The same for a pool where the currency is token0: the pool's price is Shares per currency, the reciprocal. */
function currencyFirst(
  hoursAgo: number,
  open: number,
  close: number,
  currencyVolume: number,
) {
  const raw = (price: number) => 1e12 / price;
  return {
    start: hourStart(hoursAgo),
    open: raw(open),
    high: raw(Math.min(open, close)),
    low: raw(Math.max(open, close)),
    close: raw(close),
    volume0: String(Math.round(currencyVolume * 1e6)),
    volume1: "1000000000000000000",
    trades: 2,
  };
}

const RPC = "http://127.0.0.1:18545";
/** How many Shares each project has: Aurora 1,000,000, Beacon 2,000,000. */
const SUPPLY: Record<string, bigint> = {
  [AURORA]: 1_000_000n * 10n ** 18n,
  [BEACON]: 2_000_000n * 10n ** 18n,
};

test.beforeEach(async ({ page }) => {
  // The chain, answering only what the board asks it: each project's total supply.
  await page.addInitScript((rpc) => {
    window.localStorage.setItem("buzz.launchpad.rpc", rpc);
  }, RPC);
  await page.route(RPC, async (route) => {
    const call = JSON.parse(route.request().postData() ?? "{}") as {
      id: number;
      method: string;
      params: [{ to: string }];
    };
    const supply = SUPPLY[call.params?.[0]?.to?.toLowerCase() ?? ""];
    await route.fulfill({
      json:
        call.method === "eth_call" && supply !== undefined
          ? {
              jsonrpc: "2.0",
              id: call.id,
              result: `0x${supply.toString(16).padStart(64, "0")}`,
            }
          : {
              jsonrpc: "2.0",
              id: call.id,
              error: { code: -32000, message: "unexpected" },
            },
    });
  });
  const relay = createMockRelay();
  relay.seed(launch("aurora", "Aurora", AURORA, 300));
  relay.seed(launch("beacon", "Beacon", BEACON, 200));
  relay.seed(launch("cygnus", "Cygnus", CYGNUS, 400));
  await relay.install(page);

  await page.route(`${SERVICE}/pools*`, async (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    const pools =
      token === AURORA
        ? [
            {
              id: AURORA_POOL,
              token0: AURORA,
              token1: CURRENCY,
              swaps: 4,
              lastPrice: 3e-12,
              createdAt: 1,
            },
          ]
        : token === BEACON
          ? [
              {
                id: BEACON_POOL,
                token0: CURRENCY,
                token1: BEACON,
                swaps: 2,
                lastPrice: 2e12,
                createdAt: 1,
              },
            ]
          : [];
    await route.fulfill({ json: { pools } });
  });
  await page.route(`${SERVICE}/candles*`, async (route) => {
    const pool = new URL(route.request().url()).searchParams.get("pool");
    const candles =
      pool === AURORA_POOL
        ? // 1.00 a day and a half ago, 2.00 an hour ago, 3.00 now.
          [
            sharesFirst(36, 1, 1, 100),
            sharesFirst(30, 1, 1, 100),
            sharesFirst(1, 1, 2, 4),
            sharesFirst(0, 2, 3, 6),
          ]
        : [currencyFirst(30, 0.5, 0.5, 100), currencyFirst(2, 0.5, 0.5, 3)];
    await route.fulfill({ json: { candles } });
  });
  await page.goto("/markets");
  await expect(page.getByTestId("market-row")).toHaveCount(3, {
    timeout: 20_000,
  });
});

const rowOf = (page: import("@playwright/test").Page, name: string) =>
  page.getByTestId("market-row").filter({ hasText: name });

test("each project shows its last price, its move over the day and what was traded, whichever way the pool is ordered", async ({
  page,
}) => {
  const aurora = rowOf(page, "Aurora");
  await expect(aurora.getByTestId("market-price")).toContainText("3.00");
  // From 1.00 (the last price before the day began) to 3.00.
  await expect(aurora.getByTestId("market-change")).toHaveText("+200.0% today");
  await expect(aurora.getByTestId("market-volume")).toContainText("10 ");
  // Last price times every Share there is: 3.00 x 1,000,000.
  await expect(aurora.getByTestId("market-value")).toContainText("3.0M");

  const beacon = rowOf(page, "Beacon");
  await expect(beacon.getByTestId("market-price")).toContainText("0.500");
  await expect(beacon.getByTestId("market-change")).toHaveText("0.0% today");
  await expect(beacon.getByTestId("market-volume")).toContainText("3.0");
  // 0.50 x 2,000,000.
  await expect(beacon.getByTestId("market-value")).toContainText("1.0M");
  // No trades, no value.
  await expect(rowOf(page, "Cygnus").getByTestId("market-value")).toHaveCount(
    0,
  );

  // Nothing was ever traded: no figures, said in words.
  await expect(rowOf(page, "Cygnus").getByTestId("market-untraded")).toHaveText(
    "Not traded yet",
  );
  await expect(page.getByTestId("markets-no-service")).toHaveCount(0);
});

test("the board is sorted by what was traded, and projects with no figures are always last", async ({
  page,
}) => {
  await expect(page.getByTestId("market-name")).toHaveText([
    "Aurora",
    "Beacon",
    "Cygnus",
  ]);
  await page.getByTestId("markets-sort").selectOption("change");
  await expect(page.getByTestId("market-name")).toHaveText([
    "Aurora",
    "Beacon",
    "Cygnus",
  ]);
  await page.getByTestId("markets-sort").selectOption("value");
  await expect(page.getByTestId("market-name")).toHaveText([
    "Aurora",
    "Beacon",
    "Cygnus",
  ]);
  // Newest first ignores the figures entirely.
  await page.getByTestId("markets-sort").selectOption("newest");
  await expect(page.getByTestId("market-name")).toHaveText([
    "Cygnus",
    "Aurora",
    "Beacon",
  ]);
});
