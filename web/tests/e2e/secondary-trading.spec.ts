import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { installAnvilWallet } from "../helpers/anvil-wallet";
import { createMockRelay } from "./mock-relay";

/**
 * A round of secondary trading, on a REAL local chain, in a real browser.
 *
 * Opt-in: needs the world `scripts/web-trading-e2e.sh` builds — an anvil with the v5 creation version deployed by
 * `contracts/script/V5LocalFixture.s.sol` (a DAO, its Shares, its policy and its own `SecondaryMarket`), the chain
 * warped past the founder's 180-day sale schedule, and a web build that names that market factory. Skipped without it:
 *
 *   scripts/web-trading-e2e.sh
 *
 * The story, each step a button on the page and a transaction on the chain, and each checked against the chain:
 *   1. trading is off until the DAO publishes a listing (the market exists from launch and sells nothing);
 *   2. the DAO publishes one, and the card says what it trades at and opens the week's round;
 *   3. the founder offers two lots at the lowest step, and the market holds their Shares;
 *   4. a second person bids for them at the highest step, and the market holds their quote;
 *   5. after the bidding window anyone settles the round at one price, and both orders fill the same lots;
 *   6. both collect: the buyer the Shares, the seller the money, the buyer what it overpaid — and the round's ledgers
 *      end at zero;
 *   7. someone with no order in the round is offered no collect button at all (the chain would refuse one);
 *   8. a price token that will not say its decimals is said so, and no price is printed at a guessed scale.
 *
 * What is stubbed: the relay (a mock, in the spec) and the wallets (`window.ethereum` forwarding to Anvil's accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const QUOTE = process.env.E2E_QUOTE ?? "";
const SHARES = process.env.E2E_SHARES ?? "";
const DAO = process.env.E2E_DAO ?? "";
const MARKET = process.env.E2E_MARKET ?? "";
const POLICY = process.env.E2E_POLICY ?? "";
const FOUNDER_WALLET = process.env.E2E_FOUNDER ?? "";
const BIDDER_WALLET = process.env.E2E_BIDDER ?? "";
const THIRD_WALLET = process.env.E2E_THIRD ?? "";

test.skip(
  !ANVIL_URL ||
    !QUOTE ||
    !SHARES ||
    !DAO ||
    !MARKET ||
    !POLICY ||
    !FOUNDER_WALLET ||
    !BIDDER_WALLET ||
    !THIRD_WALLET,
  "set E2E_ANVIL_URL, E2E_QUOTE, E2E_SHARES, E2E_DAO, E2E_MARKET, E2E_POLICY, E2E_FOUNDER, E2E_BIDDER and E2E_THIRD (scripts/web-trading-e2e.sh does)",
);

const FOUNDER_NSEC = "22".repeat(32);
const BIDDER_NSEC = "33".repeat(32);
const THIRD_NSEC = "44".repeat(32);

const pubkeyOf = (nsec: string) =>
  getPublicKey(
    Uint8Array.from(nsec.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
  );
const FOUNDER = pubkeyOf(FOUNDER_NSEC);

const LAUNCH_ID = "docs-commons-trading";
const WAD = 10n ** 18n;
/** Two whole lots: one lot is the market's own `lotSize`, one Share in this world. */
const LOTS = 2n;
/**
 * The listing the DAO publishes: one Share a lot, from 1 to 65 quote base units a lot, in 64 steps. The range divides
 * by the levels exactly (1 a step), which is the contract's own `InvalidTerms` rule.
 */
const MIN_PRICE = WAD;
const MAX_PRICE = 65n * WAD;
const LEVELS = 64;
/**
 * The prices the forms take, in the quote token's own units. The fixture's quote has 18 decimals, and the card reads
 * the token's own `decimals()`/`symbol()` off the chain, so a typed "1" is one whole token (1e18 base units) and the
 * card writes prices in FQ — never at a guessed six-decimal scale.
 */
const LOW_TEXT = (MIN_PRICE / WAD).toString();
const HIGH_TEXT = (MAX_PRICE / WAD).toString();
/** What the fixture's quote token calls itself (`FixtureQuote.symbol`), so the prices read as that token's money. */
const QUOTE_SYMBOL = "FQ";
/** `lots * lotSize`: what the seller escrows and the buyer receives. */
const SHARES_MOVED = LOTS * WAD;
/** What a bid at the highest step escrows: `lots * priceAt(round, 64)`. */
const BID_ESCROW = LOTS * MAX_PRICE;
/** What the round settles at: the lowest step that matches the most lots, so the lowest price. */
const CLEARING_PRICE = MIN_PRICE;
const PROCEEDS = LOTS * CLEARING_PRICE;
const REFUND = BID_ESCROW - PROCEEDS;

const DAY = 86_400;

// The market's own functions, as `cast sig` prints them (`packages/creaton-core/src/launchpad/secondary.ts` pins the
// same selectors against the contract).
const SIG = {
  balanceOf: "0x70a08231",
  listing: "0xbc7c55ed",
  rounds: "0x8c65c81f",
  sells: "0x06c17d13",
  bids: "0x3f1ffcec",
  quoteIn: "0xcedb9410",
  sharesIn: "0x5e8d2ba3",
  roundCount: "0x127f0b3f",
  saleCapacity: "0x80b4dee2",
  claimQuote: "0x4e0add6a",
  configureListing: "0x1ecf4419",
  /** The quote token's own scale, whose read this journey refuses at the end. */
  decimals: "0x313ce567",
} as const;

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

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.slice(2))
    .toLowerCase()
    .padStart(64, "0");

/** One call's answer as its 32-byte words. */
async function callWords(to: string, data: string): Promise<bigint[]> {
  const raw = String(await rpc("eth_call", [{ to, data }, "latest"]));
  const body = raw.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) {
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return out;
}

async function callWord(to: string, data: string): Promise<bigint> {
  return (await callWords(to, data))[0];
}

const balanceOf = (token: string, holder: string) =>
  callWord(token, `${SIG.balanceOf}${word(holder)}`);

/** A transaction that must have landed and succeeded: a reverted one is never evidence of a step. */
async function sendTx(tx: Record<string, unknown>): Promise<string> {
  const hash = String(await rpc("eth_sendTransaction", [tx]));
  for (let i = 0; i < 100; i++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as {
      status?: string;
    } | null;
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error(
          `transaction ${hash} did not succeed (status ${receipt.status})`,
        );
      }
      return hash;
    }
    await pause(100);
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/** Let `seconds` pass on the chain's own clock, which is what the round's windows read. */
async function passTime(seconds: number): Promise<void> {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

/**
 * The DAO publishes its listing, as the DAO itself: `configureListing` is `onlyDAO`, and on a local chain the DAO can
 * speak for itself once anvil impersonates it (the same sequence `cast rpc anvil_impersonateAccount` +
 * `cast send --from <dao> --unlocked` runs in `scripts/web-trading-e2e.sh`'s sibling journeys).
 */
async function publishListing(): Promise<void> {
  // The DAO is a contract with no ETH of its own: give it gas money, or anvil refuses to send for it.
  await rpc("anvil_setBalance", [DAO, "0x21e19e0c9bab2400000"]);
  await rpc("anvil_impersonateAccount", [DAO]);
  try {
    await sendTx({
      from: DAO,
      to: MARKET,
      data: `${SIG.configureListing}${word(1n)}${word(MIN_PRICE)}${word(MAX_PRICE)}${word(BigInt(LEVELS))}`,
    });
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [DAO]);
  }
}

/** The launch record the pages read: this fixture's DAO, named by the record's own treasury and token tags. */
function launchRecord(): StoredEvent {
  return {
    id: "record-1",
    pubkey: FOUNDER,
    created_at: 100,
    kind: 37001,
    tags: [
      ["d", LAUNCH_ID],
      ["name", "Docs Commons"],
      ["t", "dao-launchpad"],
      ["admission", "community"],
      ["chain", "31337"],
      ["treasury", DAO],
      ["token", SHARES],
    ],
    content: JSON.stringify({
      pitch: "A local project whose Shares can change hands.",
      stage: "live",
      currency: QUOTE,
      // The record names the DAO's own Shares as its token, which is what puts the Trading card on its Treasury tab.
      tokenPlan: { mode: "dao", name: "Docs", symbol: "DOCS", supply: "200" },
    }),
    sig: "sig",
  };
}

/** One person's browser: the mock relay, a wallet forwarding to anvil, and the identity the pages read. */
async function personPage(
  context: import("@playwright/test").BrowserContext,
  relay: ReturnType<typeof createMockRelay>,
  wallet: string,
  nsec: string,
): Promise<Page> {
  const page = await context.newPage();
  await relay.install(page);
  await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([key, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", key);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [nsec, ANVIL_URL],
  );
  return page;
}

/** Open the project's Treasury tab, where the market's card lives, and wait for the card to have read the chain. */
async function openTrading(page: Page): Promise<void> {
  await page.goto(`/launchpad/${LAUNCH_ID}?author=${FOUNDER}&tab=treasury`);
  await expect(page.getByTestId("trading")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("trading-state")).toBeVisible({
    timeout: 60_000,
  });
}

test("a round of secondary trading: offered, bid for, settled at one price, and collected by both sides", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const relay = createMockRelay();
  relay.seed(launchRecord());
  const say = (what: string) => console.log(`[trading] ${what}`);

  // ── 1. Trading is off: the market exists from launch, and the DAO has published no listing ─────────────
  const founder = await personPage(
    context,
    relay,
    FOUNDER_WALLET,
    FOUNDER_NSEC,
  );
  await openTrading(founder);
  await expect(founder.getByTestId("trading-state")).toContainText(
    "Trading is off: the DAO has no open listing.",
  );
  await expect(founder.getByTestId("trading-listing")).toHaveCount(0);
  await expect(founder.getByTestId("trading-open")).toHaveCount(0);
  await expect(founder.getByTestId("trading-sell")).toHaveCount(0);
  await expect(founder.getByTestId("trading-bid")).toHaveCount(0);
  // The chain agrees: the market is there, and its listing carries no terms.
  const born = await callWords(MARKET, SIG.listing);
  expect(born[0]).toBe(0n);
  expect(born[1]).toBe(0n);
  expect(born[2]).toBe(0n);
  expect(born[3]).toBe(0n);
  expect(await callWord(MARKET, SIG.roundCount)).toBe(0n);
  say("trading is off before the DAO publishes a listing");

  // ── 2. The DAO publishes the listing; the card says the real terms and opens the week's round ──────────
  await publishListing();
  const published = await callWords(MARKET, SIG.listing);
  expect(published[0]).toBe(1n);
  expect(published[1]).toBe(MIN_PRICE);
  expect(published[2]).toBe(MAX_PRICE);
  expect(published[3]).toBe(BigInt(LEVELS));
  // The founder's Shares are out of their 180-day schedule, so they can offer some (the script warped the chain).
  expect(
    await callWord(POLICY, `${SIG.saleCapacity}${word(FOUNDER_WALLET)}`),
  ).toBeGreaterThanOrEqual(SHARES_MOVED);
  await founder.reload();
  await expect(founder.getByTestId("trading-state")).toContainText(
    "Trading is on",
    { timeout: 60_000 },
  );
  // The terms are written in the quote token's own units: 1e18 base units is one whole FQ, not a trillion of them.
  await expect(founder.getByTestId("trading-state")).toContainText(
    `from 1 ${QUOTE_SYMBOL} to 65 ${QUOTE_SYMBOL} a lot`,
  );
  await expect(founder.getByTestId("trading-state")).toContainText(
    `in ${LEVELS} steps`,
  );
  await expect(founder.getByTestId("trading-state")).toContainText(
    "No round has opened yet.",
  );
  // The terms as the card reads them off the chain: one Share a lot, one whole token of quote apart.
  await expect(founder.getByTestId("trading-listing")).toContainText(
    "A lot is 1 Shares.",
  );
  await expect(founder.getByTestId("trading-listing")).toContainText(
    `Each step is 1 ${QUOTE_SYMBOL} apart.`,
  );
  await expect(founder.getByTestId("trading-open")).toBeVisible();
  await founder.getByTestId("trading-open").click();
  await expect(founder.getByTestId("trading-round")).toBeVisible({
    timeout: 60_000,
  });
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Offers and bids close",
  );
  expect(await callWord(MARKET, SIG.roundCount)).toBe(1n);
  say("the DAO published a listing and the founder opened a round");

  // ── 3. The founder offers two lots at the lowest step; the market holds their Shares ────────────────────
  const founderSharesBefore = await balanceOf(SHARES, FOUNDER_WALLET);
  expect(founderSharesBefore).toBeGreaterThanOrEqual(SHARES_MOVED);
  await founder.getByTestId("trading-sell").click();
  await founder.getByTestId("trading-sell-lots").fill(LOTS.toString());
  await founder.getByTestId("trading-sell-price").fill(LOW_TEXT);
  await expect(founder.getByTestId("trading-sell-plan-problem")).toHaveCount(0);
  await expect(founder.getByTestId("trading-sell-plan")).toContainText(
    "This holds 2 lots (2 Shares) until the round settles.",
  );
  await expect(founder.getByTestId("trading-sell-plan")).toContainText(
    `1 ${QUOTE_SYMBOL} a lot at step 0 of ${LEVELS}`,
  );
  await founder.getByTestId("trading-sell-submit").click();
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "You offer 2 lots at",
    { timeout: 90_000 },
  );
  const sell = await callWords(
    MARKET,
    `${SIG.sells}${word(1n)}${word(FOUNDER_WALLET)}`,
  );
  expect(sell[0]).toBe(LOTS); // lots
  expect(sell[1]).toBe(0n); // the lowest step
  expect(sell[2]).toBe(0n); // not filled yet
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(1n)}`)).toBe(
    SHARES_MOVED,
  );
  expect(await balanceOf(SHARES, MARKET)).toBe(SHARES_MOVED);
  expect(await balanceOf(SHARES, FOUNDER_WALLET)).toBe(
    founderSharesBefore - SHARES_MOVED,
  );
  say("the founder's two lots are held by the market");

  // ── 4. A second person bids for them at the highest step; the market holds their quote ───────────────────
  const bidder = await personPage(context, relay, BIDDER_WALLET, BIDDER_NSEC);
  await openTrading(bidder);
  await expect(bidder.getByTestId("trading-bid")).toBeVisible({
    timeout: 60_000,
  });
  const bidderQuoteBefore = await balanceOf(QUOTE, BIDDER_WALLET);
  expect(bidderQuoteBefore).toBeGreaterThanOrEqual(BID_ESCROW);
  await bidder.getByTestId("trading-bid").click();
  await bidder.getByTestId("trading-bid-lots").fill(LOTS.toString());
  await bidder.getByTestId("trading-bid-price").fill(HIGH_TEXT);
  await expect(bidder.getByTestId("trading-bid-plan-problem")).toHaveCount(0);
  await expect(bidder.getByTestId("trading-bid-plan")).toContainText(
    `This bid holds 130 ${QUOTE_SYMBOL} until the round settles.`,
  );
  await expect(bidder.getByTestId("trading-bid-plan")).toContainText(
    `65 ${QUOTE_SYMBOL} a lot at step ${LEVELS} of ${LEVELS}`,
  );
  await bidder.getByTestId("trading-bid-submit").click();
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "You bid for 2 lots at up to",
    { timeout: 90_000 },
  );
  const bid = await callWords(
    MARKET,
    `${SIG.bids}${word(1n)}${word(BIDDER_WALLET)}`,
  );
  expect(bid[0]).toBe(LOTS); // lots
  expect(bid[1]).toBe(BigInt(LEVELS)); // the highest step
  expect(bid[2]).toBe(0n); // not filled yet
  expect(await callWord(MARKET, `${SIG.quoteIn}${word(1n)}`)).toBe(BID_ESCROW);
  expect(await balanceOf(QUOTE, MARKET)).toBe(BID_ESCROW);
  expect(await balanceOf(QUOTE, BIDDER_WALLET)).toBe(
    bidderQuoteBefore - BID_ESCROW,
  );
  say("a second person's bid is held by the market");

  // ── 5. Bidding closes, anyone settles, and both orders fill the same lots at one price ─────────────────
  await passTime(3 * DAY + 60);
  await founder.reload();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Bidding is over.",
    { timeout: 60_000 },
  );
  await expect(founder.getByTestId("trading-settle")).toBeVisible();
  // While bidding is open there is no offer or bid left to place, and the round is settled by the button, not by time.
  await expect(founder.getByTestId("trading-sell")).toHaveCount(0);
  await expect(founder.getByTestId("trading-bid")).toHaveCount(0);
  await founder.getByTestId("trading-settle").click();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    `Settled at 1 ${QUOTE_SYMBOL} a lot`,
    { timeout: 90_000 },
  );
  const round = await callWords(MARKET, `${SIG.rounds}${word(1n)}`);
  expect(round[9]).toBe(1n); // settled
  expect(round[8]).toBe(0n); // the price level: the lowest step
  const settledSell = await callWords(
    MARKET,
    `${SIG.sells}${word(1n)}${word(FOUNDER_WALLET)}`,
  );
  const settledBid = await callWords(
    MARKET,
    `${SIG.bids}${word(1n)}${word(BIDDER_WALLET)}`,
  );
  expect(settledSell[2]).toBe(LOTS);
  expect(settledBid[2]).toBe(LOTS);
  expect(settledSell[2]).toBe(settledBid[2]);
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "Sold: 2 lots at the round's price.",
  );
  say("the round settled at one price and both orders filled the same lots");

  // ── 6. Both collect: the buyer the Shares, the seller the money, the buyer the rest of its bid ──────────
  await bidder.reload();
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "Bought: 2 lots at the round's price.",
    { timeout: 60_000 },
  );
  const bidderSharesBefore = await balanceOf(SHARES, BIDDER_WALLET);
  await expect(bidder.getByTestId("trading-claim-shares")).toBeVisible();
  await bidder.getByTestId("trading-claim-shares").click();
  await expect
    .poll(() => balanceOf(SHARES, BIDDER_WALLET), { timeout: 90_000 })
    .toBe(bidderSharesBefore + SHARES_MOVED);
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(1n)}`)).toBe(0n);

  const bidderQuoteBeforeClaim = await balanceOf(QUOTE, BIDDER_WALLET);
  await expect(bidder.getByTestId("trading-claim-quote")).toBeVisible();
  // The refund is written in the token's own units too: what the bid overpaid at the clearing price.
  await expect(bidder.getByTestId("trading-claim-quote")).toContainText(
    `Collect 128 ${QUOTE_SYMBOL}`,
  );
  await bidder.getByTestId("trading-claim-quote").click();
  await expect
    .poll(() => balanceOf(QUOTE, BIDDER_WALLET), { timeout: 90_000 })
    .toBe(bidderQuoteBeforeClaim + REFUND);

  const founderQuoteBefore = await balanceOf(QUOTE, FOUNDER_WALLET);
  await expect(founder.getByTestId("trading-claim-quote")).toBeVisible({
    timeout: 60_000,
  });
  // The seller is owed the clearing price for what sold, and no Shares come back: they all sold.
  await expect(founder.getByTestId("trading-claim-quote")).toContainText(
    `Collect 2 ${QUOTE_SYMBOL}`,
  );
  await expect(founder.getByTestId("trading-claim-shares")).toHaveCount(0);
  await founder.getByTestId("trading-claim-quote").click();
  await expect
    .poll(() => balanceOf(QUOTE, FOUNDER_WALLET), { timeout: 90_000 })
    .toBe(founderQuoteBefore + PROCEEDS);

  // Nothing of the round is left in the market: every Share and every unit of quote went to whom it owed.
  expect(await callWord(MARKET, `${SIG.quoteIn}${word(1n)}`)).toBe(0n);
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(1n)}`)).toBe(0n);
  expect(await balanceOf(QUOTE, MARKET)).toBe(0n);
  expect(await balanceOf(SHARES, MARKET)).toBe(0n);
  say("both sides collected and the round's ledgers are empty");

  // ── 7. Someone with no order is offered no collect button, because the chain would refuse one ───────────
  const third = await personPage(context, relay, THIRD_WALLET, THIRD_NSEC);
  await openTrading(third);
  await expect(third.getByTestId("trading-round")).toBeVisible({
    timeout: 60_000,
  });
  await expect(third.getByTestId("trading-round-status")).toContainText(
    `Settled at 1 ${QUOTE_SYMBOL} a lot`,
  );
  await expect(third.getByTestId("trading-claim")).toHaveCount(0);
  await expect(third.getByTestId("trading-claim-shares")).toHaveCount(0);
  await expect(third.getByTestId("trading-claim-quote")).toHaveCount(0);
  // And the chain agrees the button would have nothing to pay: `NothingToClaim`.
  await expect(
    rpc("eth_call", [
      {
        from: THIRD_WALLET,
        to: MARKET,
        data: `${SIG.claimQuote}${word(1n)}${word(THIRD_WALLET)}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();
  say("a wallet with no order is offered nothing to collect");

  // ── 8. A price token that will not say its decimals prints no price, and says which read it could not do ─
  // Every price is base units at the token's own scale, so a token that refuses `decimals()` leaves no scale to write
  // one at: the card says so rather than printing a figure at a guessed one.
  const quoteDown = new RegExp(
    ANVIL_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  );
  await third.route(quoteDown, (route) =>
    route.request().postData()?.includes(SIG.decimals)
      ? route.abort()
      : route.continue(),
  );
  await third.reload();
  await expect(third.getByTestId("trading-unreadable")).toContainText(
    "The market's price token couldn't be read just now, so no price can be shown.",
    { timeout: 60_000 },
  );
  // Nothing that would carry a price is shown: no listing terms, no round, no collect button.
  await expect(third.getByTestId("trading-listing")).toHaveCount(0);
  await expect(third.getByTestId("trading-round")).toHaveCount(0);
  await expect(third.getByTestId("trading-claim")).toHaveCount(0);
  // The way back is on the card, and it works once the token answers again.
  await third.unroute(quoteDown);
  await third
    .getByTestId("trading-unreadable")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(third.getByTestId("trading-round")).toBeVisible({
    timeout: 60_000,
  });
  say(
    "a price token that could not be read printed no price, and trying again found it",
  );

  await context.close();
});
