import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

/**
 * The market price in the browser, against a REAL local chain and a REAL price indexer.
 *
 * Opt-in: `scripts/web-market-e2e.sh` builds the world (a project's Shares on the Limit Break AMM with three trades in
 * it, the indexer running, the web build pointed at it) and runs this spec. What is stubbed: the relay (it serves a launch
 * record and one post).
 */

const SHARES = process.env.E2E_SHARES ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const DAO = process.env.E2E_DAO ?? "";
const NSEC = "22".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const POST_ID = "ab".repeat(32);

test.skip(
  !SHARES || !CURRENCY,
  "set E2E_SHARES and E2E_CURRENCY (scripts/web-market-e2e.sh does)",
);

interface StoredEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const record: StoredEvent = {
  id: "record-market",
  pubkey: ME,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-market"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["token", SHARES],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A market for the Shares.",
    stage: "graduated",
    currency: CURRENCY,
    floorPrice: "792281625140000",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

const post: StoredEvent = {
  id: POST_ID,
  pubkey: ME,
  created_at: 200,
  kind: 1,
  tags: [],
  content: "Backing $NEB today.",
  sig: "sig",
};

async function serve(page: import("@playwright/test").Page) {
  const events = [record, post];
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        ws.send(
          JSON.stringify(["OK", (parsed[1] as StoredEvent).id, true, ""]),
        );
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[]; ids?: string[]; "#e"?: string[] },
      ];
      for (const event of events) {
        if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
        if (filter.ids && !filter.ids.includes(event.id)) continue;
        if (filter["#e"]) continue;
        ws.send(JSON.stringify(["EVENT", subId, event]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, process.env.E2E_ANVIL_URL ?? ""],
  );
}

test("the launch page charts the traded prices, not the bids", async ({
  page,
}) => {
  await serve(page);
  await page.goto(`/launchpad/nebula-market?author=${ME}`);
  const chart = page.getByTestId("launch-price-chart");
  await expect(chart).toContainText("Prices of trades on the market.", {
    timeout: 30_000,
  });
  await expect(chart).toContainText("3 trades");
  // The buys and the sale were all near $0.01 a Share (a little above: the pool's fees and the price step).
  const last = chart.locator("dl").getByText(/USDC/).first();
  await expect(last).toBeVisible();
  const text = (await chart.locator("dl").innerText()).replace(/\s+/g, " ");
  const match = text.match(/Last ([0-9.]+) USDC/);
  expect(match, text).not.toBeNull();
  const price = Number(match?.[1]);
  expect(price).toBeGreaterThan(0.009);
  expect(price).toBeLessThan(0.0125);
  await expect(chart).not.toContainText("not market trades");
});

test("a $TICKER in a post shows the last trade, and says what it is", async ({
  page,
}) => {
  await serve(page);
  await page.goto(`/social/post/${POST_ID}`);
  const chip = page.getByTestId("social-cashtag");
  await expect(chip).toHaveCount(1, { timeout: 15_000 });
  const priceText = page.getByTestId("social-cashtag-price");
  await expect(priceText).toHaveText(/^0\.0[01]\d+ USDC$/, { timeout: 30_000 });
  const label = await chip.getAttribute("aria-label");
  expect(label).toContain("Last trade price");
  expect(label).not.toContain("not a market trade");
});
