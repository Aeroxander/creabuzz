import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

/**
 * Deploy the auction from the browser, against a REAL local chain.
 *
 * Opt-in: needs an Anvil node with the CCA factory's runtime code at its
 * canonical address, a sale token minted to the deployer, and an ERC-20 sale
 * currency. Skipped unless `E2E_ANVIL_URL`, `E2E_SALE_TOKEN` and `E2E_CURRENCY`
 * are set — `scripts/web-auction-e2e.sh`
 * builds that world and runs this spec:
 *
 *   scripts/web-auction-e2e.sh
 *
 * What is real here: the chain, the contracts (forge-built artifacts), every
 * transaction, the CREATE-address prediction and the receipts. What is stubbed:
 * the relay (an in-memory mock that stores the record the page republishes) and
 * the wallet (`window.ethereum` forwarding to Anvil's unlocked account 0, so no
 * extension is needed). The app's own reads use its default endpoint, which is
 * this Anvil.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const SALE_TOKEN = process.env.E2E_SALE_TOKEN ?? "";
// The sale currency must be an ERC-20: the graduation executor cannot settle a
// native (ETH) sale, and the deploy flow refuses one before sending anything.
const CURRENCY = process.env.E2E_CURRENCY ?? "";
// Anvil's first dev account: the treasury and the deploying wallet.
const TREASURY = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(FOUNDER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);

test.skip(
  !ANVIL_URL || !SALE_TOKEN || !CURRENCY,
  "set E2E_ANVIL_URL, E2E_SALE_TOKEN and E2E_CURRENCY (scripts/web-auction-e2e.sh does)",
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

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

function launchRecord(input: {
  admission: "curated" | "community";
  treasury: string;
  startBlock: number;
  /** Defaults to the ERC-20 sale currency; `null` = native (ETH). */
  currency?: string | null;
}): StoredEvent {
  const { startBlock } = input;
  return {
    id: "record-1",
    pubkey: FOUNDER,
    created_at: 100,
    kind: 37001,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula DAO"],
      ["t", "dao-launchpad"],
      ["admission", input.admission],
      ["chain", "31337"],
      ["token", SALE_TOKEN],
      ["treasury", input.treasury],
    ],
    content: JSON.stringify({
      pitch: "To the stars.",
      stage: "live",
      currency: input.currency === undefined ? CURRENCY : input.currency,
      floorPrice: "792281625140000",
      tickSpacing: "79228162514",
      requiredRaised: "299999999998",
      budget: "50000000000",
      startBlock,
      endBlock: startBlock + 200,
      claimBlock: startBlock + 260,
      tokenPlan: {
        mode: "mint",
        name: "Nebula Token",
        symbol: "NBL",
        supply: "200000000",
      },
    }),
    sig: "sig",
  };
}

/** A tiny relay: serves the record, and serves back whatever the page republishes. */
async function mockRelay(page: Page, initial: StoredEvent) {
  let current: StoredEvent = initial;
  const published: StoredEvent[] = [];
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
        const event = parsed[1] as StoredEvent;
        published.push(event);
        if (event.kind === 37001) current = event;
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds = filter.kinds ?? [];
      if (kinds.includes(37001)) {
        ws.send(JSON.stringify(["EVENT", subId, current]));
      }
      if (kinds.includes(47005)) {
        for (const e of published.filter((p) => p.kind === 47005)) {
          ws.send(JSON.stringify(["EVENT", subId, e]));
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  return { published, current: () => current };
}

/** `window.ethereum` forwarding to Anvil, signing as its unlocked account `account`. */
async function installWallet(page: Page, account: string) {
  await page.addInitScript(
    ({ url, account }) => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: async ({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
              return [account];
            }
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: params ?? [],
              }),
            });
            const body = await res.json();
            if (body.error) {
              throw { code: body.error.code, message: body.error.message };
            }
            return body.result;
          },
          on() {},
          removeListener() {},
        },
      });
    },
    { url: ANVIL_URL, account },
  );
}

async function openManage(page: Page) {
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [FOUNDER_NSEC, ANVIL_URL],
  );
  await page.goto("/launchpad");
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();
}

/**
 * Every deploy moves the whole sale supply into its auction, so each deploying
 * test mints a fresh supply to the treasury first (the mock token's `mint` is
 * open) and waits for it to be mined.
 */
async function mintSaleSupply(): Promise<void> {
  const to = TREASURY.slice(2).toLowerCase().padStart(64, "0");
  const amount = (200_000_000n * 10n ** 18n).toString(16).padStart(64, "0");
  const hash = await rpc("eth_sendTransaction", [
    { from: TREASURY, to: SALE_TOKEN, data: `0x40c10f19${to}${amount}` },
  ]);
  for (let i = 0; i < 40; i++) {
    if (await rpc("eth_getTransactionReceipt", [hash])) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the sale supply mint was not mined");
}

async function nextStartBlock(): Promise<number> {
  const head = Number.parseInt(String(await rpc("eth_blockNumber")), 16);
  // Far enough ahead that the deploy's own transactions do not pass it.
  return head + 500;
}

test("a community-track founder deploys, funds and binds the auction end to end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mintSaleSupply();
  const startBlock = await nextStartBlock();
  const relay = await mockRelay(
    page,
    launchRecord({ admission: "community", treasury: TREASURY, startBlock }),
  );
  await installWallet(page, TREASURY);
  await openManage(page);

  const panel = page.getByTestId("auction-deploy-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // The wallet is already granted; the gate is open for the treasury wallet.
  await expect(page.getByTestId("auction-wallet")).toContainText("chain 31337");
  await expect(page.getByTestId("auction-gate")).toHaveCount(0);
  // Community track: no bid gate, said out loud.
  await expect(page.getByTestId("auction-step-hook")).toContainText(
    "community track",
  );

  await page.getByTestId("auction-deploy").click();
  await expect(page.getByTestId("auction-status")).toContainText(
    "Auction deployed and linked to this launch.",
    { timeout: 90_000 },
  );

  for (const step of ["executor", "auction", "fund", "received", "bind"]) {
    await expect(page.getByTestId(`auction-step-${step}`)).toContainText(
      /Confirmed|Done/,
    );
  }
  await expect(page.getByTestId("auction-failure")).toHaveCount(0);

  // The record the page republished carries the auction address, and it is
  // real code on the chain.
  const linked = relay.current();
  const auction = linked.tags.find(([k]) => k === "auction")?.[1] ?? "";
  expect(auction).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(
    String(await rpc("eth_getCode", [auction, "latest"])).length,
  ).toBeGreaterThan(100);
  // The whole supply (minus the router's 1-wei lock) moved into the auction.
  const balance = BigInt(
    String(
      await rpc("eth_call", [
        {
          to: SALE_TOKEN,
          data: `0x70a08231${auction.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );
  expect(balance).toBe(200_000_000n * 10n ** 18n - 1n);

  // Once linked, the graduation panel takes over (not ready: the auction has
  // not started, and it says why instead of offering a button).
  await expect(page.getByTestId("graduation-panel")).toBeVisible({
    timeout: 15_000,
  });
  // The deploy panel is NOT swapped out at that moment: the founder keeps the
  // confirmation and the deployed addresses on screen.
  await expect(page.getByTestId("auction-deploy-panel")).toBeVisible();
  await expect(page.getByTestId("auction-status")).toContainText(
    "Auction deployed and linked to this launch.",
  );
  await expect(page.getByTestId("auction-deploy-panel")).toContainText(auction);
  await expect(page.getByTestId("graduation-execute")).toHaveCount(0);
  await expect(page.getByTestId("graduation-readiness")).not.toBeEmpty();
});

test("a wallet that is not the treasury is stopped before anything is sent", async ({
  page,
}) => {
  const startBlock = await nextStartBlock();
  await mockRelay(
    page,
    launchRecord({ admission: "community", treasury: TREASURY, startBlock }),
  );
  await installWallet(page, OTHER_ACCOUNT);
  const before = String(await rpc("eth_blockNumber"));
  await openManage(page);

  await expect(page.getByTestId("auction-deploy-panel")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("auction-gate")).toContainText(
    "Only the launch's treasury wallet",
  );
  await expect(page.getByTestId("auction-gate")).toContainText(TREASURY);
  await expect(page.getByTestId("auction-deploy")).toBeDisabled();
  // Nothing reached the chain.
  expect(String(await rpc("eth_blockNumber"))).toBe(before);
});

test("a native-currency sale is refused before anything is sent", async ({
  page,
}) => {
  // The graduation executor cannot settle a native (ETH) sale: `bindAuction`
  // reverts NativeCurrencyUnsupported. Deploying anyway would spend gas on
  // five irreversible steps and move the whole supply into an auction that can
  // never graduate. The gate must stop it up front.
  const startBlock = await nextStartBlock();
  await mockRelay(
    page,
    launchRecord({
      admission: "community",
      treasury: TREASURY,
      startBlock,
      currency: null,
    }),
  );
  await installWallet(page, TREASURY);
  const before = String(await rpc("eth_blockNumber"));
  await openManage(page);

  await expect(page.getByTestId("auction-deploy-panel")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("auction-gate")).toContainText("ERC-20");
  await expect(page.getByTestId("auction-deploy")).toBeDisabled();
  expect(String(await rpc("eth_blockNumber"))).toBe(before);
});

test("the curated track also deploys and locks the bid gate to the auction", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mintSaleSupply();
  const startBlock = await nextStartBlock();
  const relay = await mockRelay(
    page,
    launchRecord({ admission: "curated", treasury: TREASURY, startBlock }),
  );
  await installWallet(page, TREASURY);
  await openManage(page);

  await expect(page.getByTestId("auction-deploy-panel")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId("auction-deploy").click();
  await expect(page.getByTestId("auction-status")).toContainText(
    "Auction deployed and linked to this launch.",
    { timeout: 90_000 },
  );
  // All seven steps ran, including the two that only exist on this track.
  for (const step of [
    "hook",
    "executor",
    "auction",
    "hookAuction",
    "fund",
    "received",
    "bind",
  ]) {
    await expect(page.getByTestId(`auction-step-${step}`)).toContainText(
      /Confirmed|Done/,
    );
  }
  const auction =
    relay.current().tags.find(([k]) => k === "auction")?.[1] ?? "";
  expect(auction).toMatch(/^0x[0-9a-fA-F]{40}$/);
});
