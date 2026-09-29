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
// The ERC-20 ("Dev USDC", 6 decimals) an USDC sale raises in. ETH sales need none.
const CURRENCY = process.env.E2E_CURRENCY ?? "";
// Anvil's second dev account: the bidder in the graduation journeys.
const BIDDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
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

/**
 * The sale terms per currency, as the app's own maths produces them for a
 * graduating auction of 200,000,000 tokens: USDC at 0.01 a token (threshold
 * 300,000 USDC), ETH at 0.000004 a token (threshold 120 ETH).
 */
const TERMS = {
  usdc: {
    floorPrice: "792281625140000",
    tickSpacing: "79228162514",
    requiredRaised: "299999999998",
  },
  eth: {
    floorPrice: "316912650057057350370000",
    tickSpacing: "31691265005705735037",
    requiredRaised: "119999999999999999998",
  },
} as const;

function launchRecord(input: {
  admission: "curated" | "community";
  treasury: string;
  startBlock: number;
  /** Defaults to the ERC-20 sale currency; `null` = native (ETH). */
  currency?: string | null;
}): StoredEvent {
  const { startBlock } = input;
  const currency = input.currency === undefined ? CURRENCY : input.currency;
  const terms = currency === null ? TERMS.eth : TERMS.usdc;
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
      currency,
      floorPrice: terms.floorPrice,
      tickSpacing: terms.tickSpacing,
      requiredRaised: terms.requiredRaised,
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
async function installWallet(
  page: Page,
  account: string,
  options: { rejectFirstSend?: boolean } = {},
) {
  await page.addInitScript(
    ({ url, account, rejectFirstSend }) => {
      let sends = 0;
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
            // The first send is declined (as if the user pressed Reject); every
            // later one goes through, so the flow can be retried to the end.
            if (
              method === "eth_sendTransaction" &&
              rejectFirstSend &&
              sends++ === 0
            ) {
              throw {
                code: 4001,
                message: "User denied transaction signature",
              };
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
    {
      url: ANVIL_URL,
      account,
      rejectFirstSend: options.rejectFirstSend ?? false,
    },
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

test("declining a transaction is recoverable: nothing was sent, and retry finishes the deploy", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mintSaleSupply();
  const startBlock = await nextStartBlock();
  const relay = await mockRelay(
    page,
    launchRecord({ admission: "community", treasury: TREASURY, startBlock }),
  );
  await installWallet(page, TREASURY, { rejectFirstSend: true });
  await openManage(page);
  const head = String(await rpc("eth_blockNumber"));

  await page.getByTestId("auction-deploy").click();
  const failure = page.getByTestId("auction-failure");
  await expect(failure).toBeVisible({ timeout: 30_000 });
  // A user's "no" is a known outcome: say so, do not send them looking for a
  // transaction that was never broadcast.
  await expect(failure).toContainText("You declined");
  await expect(failure).toContainText("nothing was sent for this step");
  await expect(failure).not.toContainText("may or may not");
  // The address shown for the never-deployed contract is labelled as expected.
  await expect(page.getByTestId("auction-deploy-panel")).toContainText(
    "Graduation executor (expected address)",
  );
  expect(String(await rpc("eth_blockNumber"))).toBe(head);

  // Retry carries on from the declined step and completes the whole deploy.
  await page.getByTestId("auction-retry").click();
  await expect(page.getByTestId("auction-status")).toContainText(
    "Auction deployed and linked to this launch.",
    { timeout: 90_000 },
  );
  await expect(page.getByTestId("auction-failure")).toHaveCount(0);
  const auction =
    relay.current().tags.find(([k]) => k === "auction")?.[1] ?? "";
  expect(auction).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

// ---------------------------------------------------------------------------
// The whole journey, per currency: deploy -> bid -> the auction ends -> graduate
// ---------------------------------------------------------------------------

async function head(): Promise<number> {
  return Number.parseInt(String(await rpc("eth_blockNumber")), 16);
}

/** Mine blocks until the chain is past `block` (Anvil mines on demand). */
async function mineTo(block: number): Promise<void> {
  const missing = block - (await head());
  if (missing > 0) await rpc("anvil_mine", [`0x${missing.toString(16)}`]);
}

async function ethCallWord(to: string, data: string): Promise<bigint> {
  return BigInt(String(await rpc("eth_call", [{ to, data }, "latest"])));
}

/** The eight words of `GraduationExecutor.graduations(auction)`. */
async function graduationRecord(executor: string, auction: string) {
  const raw = String(
    await rpc("eth_call", [
      {
        to: executor,
        data: `0x62e3857f${auction.slice(2).toLowerCase().padStart(64, "0")}`,
      },
      "latest",
    ]),
  );
  const words = raw.slice(2).match(/.{64}/g) ?? [];
  const w = (i: number) => BigInt(`0x${words[i] ?? "0"}`);
  return {
    currencyRaised: w(2),
    reserveEscrow: w(3),
    treasuryShare: w(4),
    unsoldTokens: w(5),
    pool: w(6),
    executed: w(7) === 1n,
  };
}

async function tokenBalance(token: string, holder: string): Promise<bigint> {
  return ethCallWord(
    token,
    `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`,
  );
}

async function waitMined(
  hash: string,
): Promise<{ gasUsed: bigint; price: bigint }> {
  for (let i = 0; i < 60; i++) {
    const r = (await rpc("eth_getTransactionReceipt", [hash])) as {
      gasUsed: string;
      effectiveGasPrice: string;
    } | null;
    if (r)
      return { gasUsed: BigInt(r.gasUsed), price: BigInt(r.effectiveGasPrice) };
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

const JOURNEYS = [
  {
    name: "ETH",
    currency: null as string | null,
    symbol: "ETH",
    // 200 ETH against a 120 ETH threshold: a comfortable graduation.
    budget: "200",
    raisedAtLeast: 120n * 10n ** 18n,
  },
  {
    name: "USDC",
    currency: "usdc" as string | null,
    symbol: "USDC",
    // 400,000 USDC against a 300,000 USDC threshold.
    budget: "400000",
    raisedAtLeast: 300_000n * 10n ** 6n,
  },
];

for (const journey of JOURNEYS) {
  test(`${journey.name} sale: deploy, bid, the auction ends, graduation executes`, async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const erc20 = journey.currency === null ? null : CURRENCY;
    await mintSaleSupply();
    if (erc20) {
      // The bidder holds 1,000,000 of the sale currency (the mock's mint is open).
      const to = BIDDER.slice(2).toLowerCase().padStart(64, "0");
      const amount = (1_000_000n * 10n ** 6n).toString(16).padStart(64, "0");
      const hash = await rpc("eth_sendTransaction", [
        { from: TREASURY, to: erc20, data: `0x40c10f19${to}${amount}` },
      ]);
      await waitMined(String(hash));
    }
    const startBlock = await nextStartBlock();
    const endBlock = startBlock + 200;

    // ── 1. The treasury deploys the auction through the UI ──────────────────
    const relay = await mockRelay(
      page,
      launchRecord({
        admission: "community",
        treasury: TREASURY,
        startBlock,
        currency: erc20,
      }),
    );
    await installWallet(page, TREASURY);
    await openManage(page);
    await page.getByTestId("auction-deploy").click();
    await expect(page.getByTestId("auction-status")).toContainText(
      "Auction deployed and linked to this launch.",
      { timeout: 90_000 },
    );
    const linked = relay.current();
    const auction = linked.tags.find(([k]) => k === "auction")?.[1] ?? "";
    expect(auction).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const executor = `0x${(await ethCallWord(auction, "0x3b6fd2cf"))
      .toString(16)
      .padStart(40, "0")}`;

    // Before the auction ends, graduation says so plainly and offers nothing.
    await expect(page.getByTestId("graduation-readiness")).toContainText(
      "still running",
    );
    await expect(page.getByTestId("graduation-execute")).toHaveCount(0);

    // ── 2. A bidder bids through the real bid dialog ─────────────────────────
    await mineTo(startBlock + 2);
    const bidderPage = await context.newPage();
    await mockRelay(bidderPage, linked);
    await installWallet(bidderPage, BIDDER);
    await bidderPage.addInitScript(
      ([rpcUrl]) => window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl),
      [ANVIL_URL],
    );
    await bidderPage.goto("/launchpad");
    await bidderPage.getByText("Nebula DAO").click();
    await bidderPage.getByRole("button", { name: "Back this launch" }).click();
    // The sale is in its own currency, in plain units.
    await expect(
      bidderPage.getByText(`Your budget (${journey.symbol})`),
    ).toBeVisible();
    // The suggested ceiling is a clean number (twice the floor), not the floor's
    // tick-snapping residue (0.000007999999999999).
    await expect(bidderPage.getByTestId("bid-max-price")).toHaveValue(
      journey.name === "ETH" ? "0.000008" : "0.02",
    );
    await bidderPage.getByTestId("bid-budget").fill(journey.budget);
    await expect(bidderPage.getByTestId("bid-issues")).toHaveCount(0);
    await bidderPage.getByTestId("bid-send").click();
    await expect(bidderPage.getByTestId("bid-tx")).toHaveValue(
      /^0x[0-9a-f]{64}$/,
      { timeout: 60_000 },
    );

    // The hash the dialog shows must be a bid that LANDED, not one that reverted.
    const bidTx = await bidderPage.getByTestId("bid-tx").inputValue();
    const bidReceipt = (await rpc("eth_getTransactionReceipt", [bidTx])) as {
      status: string;
    } | null;
    expect(bidReceipt?.status, `bid ${bidTx} was not successful`).toBe("0x1");

    // ── 3. The auction ends; the treasury graduates it ───────────────────────
    await mineTo(endBlock + 2);
    const treasuryBefore = erc20
      ? await tokenBalance(erc20, TREASURY)
      : BigInt(String(await rpc("eth_getBalance", [TREASURY, "latest"])));
    await page.getByRole("button", { name: "Re-check" }).click();
    await expect(page.getByTestId("graduation-readiness")).toContainText(
      "ended and raised enough",
      { timeout: 30_000 },
    );
    await page.getByTestId("graduation-execute").click();
    await expect(page.getByTestId("graduation-status")).toContainText(
      "Graduation executed and both receipts published.",
      { timeout: 90_000 },
    );
    await expect(page.getByTestId("graduation-failure")).toHaveCount(0);
    // The panel says what happened, in the sale's own currency.
    const result = page.getByTestId("graduation-result");
    await expect(result).toContainText("Raised");
    await expect(result).toContainText(journey.symbol);
    await expect(result).toContainText("Paid to the treasury");
    await expect(result).toContainText("Held in reserve for the price floor");

    // ── 4. The chain agrees ──────────────────────────────────────────────────
    const g = await graduationRecord(executor, auction);
    expect(g.executed).toBe(true);
    expect(g.currencyRaised).toBeGreaterThanOrEqual(journey.raisedAtLeast);
    // 40% is escrowed for the price floor, the rest is the treasury's.
    expect(g.reserveEscrow).toBe((g.currencyRaised * 4000n) / 10_000n);
    expect(g.reserveEscrow + g.treasuryShare).toBe(g.currencyRaised);
    expect(g.pool).toBe(0n);
    const escrowed = erc20
      ? await tokenBalance(erc20, executor)
      : BigInt(String(await rpc("eth_getBalance", [executor, "latest"])));
    expect(escrowed).toBe(g.reserveEscrow);
    // Unsold sale tokens went back to the treasury as tokens.
    expect(g.unsoldTokens).toBeGreaterThan(0n);

    // ── 5. The receipts reached the relay, bound to the graduation tx ────────
    const receipts = relay.published.filter((e) => e.kind === 47005);
    const kinds = receipts.map((e) => e.tags.find(([k]) => k === "kind")?.[1]);
    expect(kinds.sort()).toEqual(["lock", "sweep"]);
    const txHash = receipts[0]?.tags.find(([k]) => k === "tx")?.[1] ?? "";
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    for (const receipt of receipts) {
      expect(receipt.tags.find(([k]) => k === "tx")?.[1]).toBe(txHash);
    }
    // The treasury received its share (in ETH, net of the gas it paid).
    const { gasUsed, price } = await waitMined(txHash);
    const treasuryAfter = erc20
      ? await tokenBalance(erc20, TREASURY)
      : BigInt(String(await rpc("eth_getBalance", [TREASURY, "latest"])));
    expect(
      treasuryAfter - treasuryBefore + (erc20 ? 0n : gasUsed * price),
    ).toBe(g.treasuryShare);

    // ── 6. Coming back later: the panel shows the outcome, offers no second go ─
    const receiptsBefore = relay.published.filter(
      (e) => e.kind === 47005,
    ).length;
    await page.reload();
    await page.getByText("Nebula DAO").click();
    await page.getByRole("tab", { name: /Manage/ }).click();
    await expect(page.getByTestId("graduation-readiness")).toContainText(
      "already been graduated",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("graduation-result")).toContainText("Raised");
    await expect(page.getByTestId("graduation-execute")).toHaveCount(0);
    expect(relay.published.filter((e) => e.kind === 47005).length).toBe(
      receiptsBefore,
    );
    await bidderPage.close();
  });
}
