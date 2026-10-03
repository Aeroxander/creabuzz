import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAs, waitForEvents } from "./social-helpers.mjs";

/**
 * The founder's whole journey, on a REAL relay and a REAL local chain:
 *
 *   idea -> quick sale setup -> commitments -> link the token -> deploy the
 *   auction -> go live -> a backer bids -> the founder admits them -> the
 *   backer is in the gated room.
 *
 * Opt-in: needs the Anvil world `scripts/web-auction-e2e.sh` builds, plus a
 * relay serving `web/dist` (tests/e2e-real/README.md). Run it with
 *
 *   E2E_SPEC=tests/e2e-real/journey.spec.ts \
 *   E2E_CONFIG=playwright.local-chromium.config.ts scripts/web-auction-e2e.sh
 *
 * Real: the relay, the chain, every transaction and every channel write. Stubbed:
 * only the wallet (`window.ethereum` forwarding to Anvil's unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
// Mock world (scripts/web-auction-e2e.sh): a prebuilt token is linked and the
// sale raises in a mock USDC. Apptoken world (scripts/web-mint-e2e.sh): the token
// is minted from the browser on the apptoken local environment, and the sale
// raises in ETH.
const APPTOKEN = process.env.E2E_APPTOKEN === "1";
const SALE_TOKEN = process.env.E2E_SALE_TOKEN ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const CHAIN_ID = process.env.E2E_CHAIN_ID ?? "31337";
const TREASURY = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BIDDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BASE_URL = process.env.BUZZ_REAL_RELAY_URL ?? "http://localhost:3199";

test.skip(
  !ANVIL_URL || (!APPTOKEN && (!SALE_TOKEN || !CURRENCY)),
  "set E2E_ANVIL_URL (and E2E_SALE_TOKEN, E2E_CURRENCY) — scripts/web-auction-e2e.sh or scripts/web-mint-e2e.sh do",
);
test.use({ viewport: { width: 1360, height: 900 } });

interface Fixture {
  people: Record<"dev" | "alice" | "bob" | "carol", string>;
  nsecs: Record<"dev" | "alice" | "bob" | "carol", string>;
}

function fixtureOrSkip(): Fixture {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    ".social-fixture.json",
  );
  if (!existsSync(path)) {
    test.skip(true, "seed the real relay first (tests/e2e-real/README.md)");
  }
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
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

async function waitMined(hash: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (await rpc("eth_getTransactionReceipt", [hash])) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/** The mock ERC-20's `mint(address,uint256)` is open to anyone. */
async function mint(token: string, to: string, amount: bigint): Promise<void> {
  const data = `0x40c10f19${to.slice(2).toLowerCase().padStart(64, "0")}${amount
    .toString(16)
    .padStart(64, "0")}`;
  await waitMined(
    String(
      await rpc("eth_sendTransaction", [{ from: TREASURY, to: token, data }]),
    ),
  );
}

async function mineTo(block: number): Promise<void> {
  const head = Number.parseInt(String(await rpc("eth_blockNumber")), 16);
  if (block > head)
    await rpc("anvil_mine", [`0x${(block - head).toString(16)}`]);
}

/** `window.ethereum` forwarding to Anvil, signing as its unlocked `account`. */
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

async function signIn(page: Page, nsec: string, wallet: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ([key, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", key);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [nsec, ANVIL_URL],
  );
  await installWallet(page, wallet);
  return errors;
}

const RUN = Date.now().toString(36);

test("idea to sale to backer: the founder's whole journey on a real relay and chain", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const fixture = fixtureOrSkip();
  const errors = await signIn(page, fixture.nsecs.dev, TREASURY);
  if (!APPTOKEN) await mint(SALE_TOKEN, TREASURY, 200_000_000n * 10n ** 18n);

  // ── 1. An idea, in one step ───────────────────────────────────────────────
  const name = `Journey ${RUN}`;
  await page.goto("/launchpad");
  await page.getByTestId("start-idea").first().click();
  await page.getByTestId("idea-name").fill(name);
  await page
    .getByTestId("idea-pitch")
    .fill("A journey from an idea to a sale.");
  await page.getByTestId("idea-create").click();
  await expect(page.getByTestId("idea-progress")).toBeVisible({
    timeout: 30_000,
  });
  const launchId = new URL(page.url()).pathname.split("/").pop() as string;
  const launchUrl = `/launchpad/${launchId}?author=${fixture.people.dev}`;

  const latest = async () => {
    const events = await waitForEvents("dev", {
      kinds: [37001],
      authors: [fixture.people.dev],
      "#d": [launchId],
    });
    return events.sort(
      (a: { created_at: number }, b: { created_at: number }) =>
        b.created_at - a.created_at,
    )[0];
  };
  /** The newest stored record, once `ready` says it carries what we wait for. */
  const latestWhere = async (
    ready: (record: { tags: string[][]; content: string }) => boolean,
  ) => {
    for (let i = 0; i < 40; i += 1) {
      const record = await latest();
      if (ready(record)) return record;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the relay never stored the expected record");
  };

  // ── 2. Prepare the sale: two choices, on this chain, open to everyone ─────
  await page.getByTestId("idea-prepare-anyway").click();
  await expect(page.getByTestId("quick-sale")).toBeVisible();
  // A local sale is in the dev USDC (or ETH), on this chain, open to everyone.
  await page.getByTestId("quick-customize").click();
  await page.getByTestId("launch-advanced").locator("> summary").click();
  if (CHAIN_ID !== "31337") {
    await page.getByLabel("Chain id").fill(CHAIN_ID);
  }
  await page.getByRole("button", { name: "community", exact: true }).click();
  await page.getByTestId("quick-back").click();
  await page.getByRole("button", { name: /Publish launch/ }).click();
  await expect(page.getByTestId("sale-progress")).toBeVisible({
    timeout: 30_000,
  });
  let record = await latestWhere((r) =>
    Boolean(JSON.parse(r.content).floorPrice),
  );
  expect(record.tags).toContainEqual(["chain", CHAIN_ID]);
  expect((JSON.parse(record.content).currency ?? "").toLowerCase()).toBe(
    APPTOKEN ? "" : CURRENCY.toLowerCase(),
  );

  // ── 3. Commitments: asked here, because going live needs them ─────────────
  await expect(page.getByTestId("sale-step-commitments")).toBeVisible();
  await page.getByTestId("sale-step-commitments").click();
  await page
    .getByTestId("commit-story")
    .fill(
      "We build open tools for people who look up. Prototype exists; the raise funds the first release.",
    );
  await page.getByTestId("commit-save").click();
  record = await latestWhere((r) => Boolean(JSON.parse(r.content).budget));
  const saved = JSON.parse(record.content);
  expect(saved.updateCadence).toBeTruthy();
  // Saving commitments must not erase what the sale already carries.
  expect(saved.floorPrice).toBeTruthy();
  expect(saved.chat.backers).toMatch(/^[0-9a-f-]{36}$/);
  const chat = saved.chat as {
    team: string;
    supporters: string;
    backers: string;
  };

  // ── 4. The token: minted from the browser, or a prebuilt one linked ──────
  await expect(page.getByTestId("sale-step-deploy")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("sale-step-deploy").click();
  if (APPTOKEN) {
    await page.getByTestId("mint-deploy").click();
    await expect(page.getByTestId("mint-step-link")).toContainText(
      /Done|Confirmed|Linked/i,
      { timeout: 120_000 },
    );
    await expect(page.getByTestId("mint-failure")).toHaveCount(0);
  } else {
    await page.locator("#mint-address").fill(SALE_TOKEN);
    await page.getByRole("button", { name: "Link", exact: true }).click();
  }
  await latestWhere((r) => r.tags.some((t) => t[0] === "token"));

  await expect(page.getByTestId("auction-deploy-panel")).toBeVisible({
    timeout: 30_000,
  });
  // A quick setup never asked for a treasury: the connected wallet is one click
  // (minting in the browser already records the deployer as the treasury).
  if (!APPTOKEN) await page.getByTestId("auction-use-wallet").click();
  const withTreasury = await latestWhere((r) =>
    r.tags.some((t) => t[0] === "treasury"),
  );
  expect(withTreasury.tags.find((t) => t[0] === "treasury")?.[1]).toBe(
    TREASURY,
  );
  await expect(page.getByTestId("auction-deploy")).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByTestId("auction-deploy").click();
  await expect(page.getByTestId("auction-status")).toContainText(
    "Auction deployed and linked to this launch.",
    { timeout: 120_000 },
  );
  record = await latestWhere((r) => r.tags.some((t) => t[0] === "auction"));
  const auction = record.tags.find((t) => t[0] === "auction")?.[1] ?? "";
  expect(auction).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // The chain agrees: real code at the auction and the token, and the sale
  // supply moved into the auction (the token, minted or linked, is the one sold).
  const token = record.tags.find((t) => t[0] === "token")?.[1] ?? "";
  for (const address of [auction, token]) {
    expect(
      String(await rpc("eth_getCode", [address, "latest"])).length,
    ).toBeGreaterThan(100);
  }
  const held = BigInt(
    String(
      await rpc("eth_call", [
        {
          to: token,
          data: `0x70a08231${auction.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );
  expect(held).toBeGreaterThanOrEqual(199_999_999n * 10n ** 18n);
  // Linking and deploying kept the story, the rooms and the terms.
  const deployed = JSON.parse(record.content);
  expect(deployed.longPitch).toBeTruthy();
  expect(deployed.chat).toEqual(chat);

  // ── 5. Go live: the walk-through hands over to "tell your supporters" ─────
  await page.goto(launchUrl);
  await expect(page.getByTestId("sale-step-open")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("sale-step-open").click();
  await expect(page.getByTestId("sale-step-announce")).toBeVisible({
    timeout: 30_000,
  });
  record = await latestWhere((r) => JSON.parse(r.content).stage === "live");

  // ── 6. A backer bids, from their own browser and wallet ──────────────────
  const startBlock = JSON.parse(record.content).startBlock as number;
  await mineTo(startBlock + 2);
  if (!APPTOKEN) await mint(CURRENCY, BIDDER, 1_000_000n * 10n ** 6n);
  const aliceContext = await browser.newContext({
    viewport: { width: 1360, height: 900 },
  });
  try {
    const alice = await aliceContext.newPage();
    await signIn(alice, fixture.nsecs.alice, BIDDER);
    await alice.goto(`${BASE_URL}${launchUrl}`);
    await expect(alice.getByTestId("launch-chat-locked")).toBeVisible({
      timeout: 30_000,
    });
    await alice.getByRole("button", { name: "Back this launch" }).click();
    await alice.getByTestId("bid-budget").fill(APPTOKEN ? "5" : "1000");
    await expect(alice.getByTestId("bid-issues")).toHaveCount(0);
    await alice.getByTestId("bid-send").click();

    // Sending the bid recorded it, so she now waits for the founder.
    await expect(alice.getByTestId("launch-chat-pending")).toBeVisible({
      timeout: 60_000,
    });
    const bids = await waitForEvents("alice", {
      kinds: [47002],
      authors: [fixture.people.alice],
    });
    expect(JSON.parse(bids[0].content).tx).toMatch(/^0x[0-9a-f]{64}$/);

    // She cannot see the gated room, or the team's.
    for (const room of [chat.backers, chat.team]) {
      expect(
        await readAs("alice", { kinds: [39000], "#d": [room] }),
      ).toHaveLength(0);
    }

    // ── 7. The founder lets her in with one click ──────────────────────────
    await page.goto(launchUrl);
    await expect(page.getByTestId("launch-chat-admit")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("launch-chat-admit-button").click();
    await expect(page.getByTestId("launch-chat-admit")).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(
      await waitForEvents("alice", { kinds: [39000], "#d": [chat.backers] }),
    ).toHaveLength(1);
    expect(
      await readAs("alice", { kinds: [39000], "#d": [chat.team] }),
    ).toHaveLength(0);

    await alice.reload();
    await expect(alice.getByTestId("launch-chat-open-backers")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await aliceContext.close();
  }
  expect(errors, errors.join(" | ")).toEqual([]);
});
