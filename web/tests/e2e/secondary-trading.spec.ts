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
 *   8. a price token that will not say its decimals is said so, and no price is printed at a guessed scale;
 *   9. (second test) a round nobody settled goes void, the next week's round opens, and the card still offers each
 *      wallet what the void round owes it (the seller's Shares, the buyer's money), because a claim never expires and
 *      the new round must not hide it.
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

// The second test continues the world the first one leaves (one settled round), so the file runs in order.
test.describe.configure({ mode: "serial" });

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
/** A second offer price, so two settled rounds in the Earlier rounds list can be told apart by price. */
const LATER_TEXT = "5";
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
  /** `allowance(owner, spender)`: what a token already lets the market take. */
  allowance: "0xdd62ed3e",
  claimQuote: "0x4e0add6a",
  claimShares: "0xace1f5e1",
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
/**
 * Collect (or take back, or settle) by keyboard alone, the way a keyboard or screen-reader user does: the button goes
 * away once the step has landed and the page has refreshed, and the cursor must not be dropped on the page body. It
 * ends inside the card, on something that can be read, so the next Tab or arrow starts from the result.
 */
async function activateByKeyboardAndKeepFocus(
  page: Page,
  testId: string,
): Promise<void> {
  const button = page.getByTestId(testId);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveCount(0, { timeout: 90_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return (
            active !== null &&
            active !== document.body &&
            active.closest('[data-testid="trading"]') !== null
          );
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/**
 * Fill both fields, press Enter in the price field, and check the form said why instead of doing nothing: the problem
 * is in the polite region, the field it belongs to is marked invalid and holds the cursor, and the field is tied to the
 * region by `aria-describedby`. Leaves the form open.
 */
async function expectEnterSaysWhy(
  page: Page,
  prefix: string,
  want: { lots: string; price: string; problem: string; invalid: string },
): Promise<void> {
  const lots = page.getByTestId(`${prefix}-lots`);
  const price = page.getByTestId(`${prefix}-price`);
  await lots.fill(want.lots);
  await price.fill(want.price);
  await price.focus();
  await page.keyboard.press("Enter");
  const problem = page.getByTestId(`${prefix}-plan-problem`);
  await expect(problem).toContainText(want.problem);
  const field = page.getByTestId(want.invalid);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  // Only the field with the mistake is marked: the other one is fine.
  const other = page.getByTestId(
    want.invalid === `${prefix}-lots` ? `${prefix}-price` : `${prefix}-lots`,
  );
  await expect(other).not.toHaveAttribute("aria-invalid", "true");
  const live = await page.getByTestId(`${prefix}-plan-live`).getAttribute("id");
  expect((await field.getAttribute("aria-describedby")) ?? "").toContain(
    live ?? "never",
  );
}

async function openTrading(page: Page): Promise<void> {
  await page.goto(`/launchpad/${LAUNCH_ID}?author=${FOUNDER}&tab=treasury`);
  await expect(page.getByTestId("trading")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("trading-state")).toBeVisible({
    timeout: 60_000,
  });
}

/** The sentence that must sit beside every settled price (brief Q14: one person can set a round's price). */
const PRICE_LABEL =
  "One person can set a round's price. An account can sell and buy in the same round, and one person can hold more than one account.";

/**
 * The permanent label is visible as plain text right under the settled price, is not a tooltip or a control, and stays
 * inside the viewport (so a phone does not scroll sideways to read it).
 */
async function expectPriceLabel(page: Page) {
  // The latest round's own label: the Earlier rounds list carries its own, checked by `expectHistory`.
  const note = page
    .getByTestId("trading-round")
    .getByTestId("price-setter-note");
  await expect(note).toBeVisible();
  await expect(note).toHaveText(PRICE_LABEL);
  // Plain text: no tooltip title, no own accessible name, nothing to click away.
  await expect(note).not.toHaveAttribute("title", /.*/);
  await expect(note).not.toHaveAttribute("aria-label", /.*/);
  await expect(note.locator("button, a, input")).toHaveCount(0);
  const status = await page.getByTestId("trading-round-status").boundingBox();
  const box = await note.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  if (!status || !box) throw new Error("the price and its label are on screen");
  // Right under the price line (no other block between them), and wholly inside the viewport.
  expect(box.y).toBeGreaterThanOrEqual(status.y + status.height - 1);
  expect(box.y - (status.y + status.height)).toBeLessThan(24);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

/**
 * The Earlier rounds list: one row per round below the latest, newest first, each with the day it opened (and its
 * time zone) and either the lots traded at their price or "No trade". The permanent label sits once right under the
 * list when any row prints a price, is plain text inside the viewport, and is absent when none does.
 */
async function expectHistory(
  page: Page,
  expected: { id: number; outcome: string }[],
) {
  const list = page.getByTestId("trading-history");
  await expect(
    list.getByRole("heading", { name: "Earlier rounds" }),
  ).toBeVisible({ timeout: 60_000 });
  const rows = list.getByTestId("trading-history-row");
  await expect(rows).toHaveCount(expected.length, { timeout: 60_000 });
  for (const [i, row] of expected.entries()) {
    const line = rows.nth(i);
    await expect(line).toHaveAttribute("data-round-id", String(row.id));
    await expect(line.locator("span").nth(0)).toHaveText(
      /^Opened [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M \S+$/,
    );
    await expect(line.locator("span").nth(1)).toHaveText(row.outcome);
  }
  const note = list.getByTestId("price-setter-note");
  if (expected.some((r) => r.outcome !== "No trade")) {
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText(PRICE_LABEL);
    await expect(note).not.toHaveAttribute("title", /.*/);
    await expect(note).not.toHaveAttribute("aria-label", /.*/);
    const last = await rows.nth(expected.length - 1).boundingBox();
    const box = await note.boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    if (!last || !box) throw new Error("the list and its label are on screen");
    // Right under the whole list, and wholly inside the viewport.
    expect(box.y).toBeGreaterThanOrEqual(last.y + last.height - 1);
    expect(box.y - (last.y + last.height)).toBeLessThan(24);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  } else {
    await expect(note).toHaveCount(0);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
    "Trading is off: the project has no open listing.",
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
    "A lot is 1 Share.",
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

  // ── 2b. An offer the wallet cannot make is refused on the page, with the reason, before anything is signed ──
  // Someone who holds no Shares has nothing the policy lets them offer (`saleCapacity` is 0 for them).
  const nobody = await personPage(context, relay, THIRD_WALLET, THIRD_NSEC);
  await openTrading(nobody);
  expect(await balanceOf(SHARES, THIRD_WALLET)).toBe(0n);
  expect(
    await callWord(POLICY, `${SIG.saleCapacity}${word(THIRD_WALLET)}`),
  ).toBe(0n);
  await nobody.getByTestId("trading-sell").click();
  await expect(nobody.getByTestId("trading-sell-room")).toContainText(
    "You hold no Shares in this project, so there is nothing to offer.",
  );
  await nobody.getByTestId("trading-sell-lots").fill("1");
  await nobody.getByTestId("trading-sell-price").fill(LOW_TEXT);
  // A problem is shown once the person has left the field (or tried to send), never on every keystroke.
  await nobody.getByTestId("trading-sell-price").blur();
  await expect(nobody.getByTestId("trading-sell-plan-problem")).toContainText(
    "You hold no Shares in this project, so there is nothing to offer.",
  );
  // The send button stays reachable; pressing it says the problem again, hands the cursor to the lots and sends nothing.
  await nobody.getByTestId("trading-sell-submit").click();
  await expect(nobody.getByTestId("trading-sell-lots")).toBeFocused();
  await expect(nobody.getByTestId("trading-sell-plan-problem")).toBeVisible();
  await expect(nobody.getByTestId("trading-my-sell")).toHaveCount(0);
  // Nothing was approved or offered: the page refused it, not the chain after a signature.
  expect(
    await callWord(
      SHARES,
      `${SIG.allowance}${word(THIRD_WALLET)}${word(MARKET)}`,
    ),
  ).toBe(0n);
  expect(await callWord(MARKET, SIG.roundCount)).toBe(1n);
  say("a wallet with nothing to offer is told so before it signs anything");

  // ── 3. The founder offers two lots at the lowest step; the market holds their Shares ────────────────────
  const founderSharesBefore = await balanceOf(SHARES, FOUNDER_WALLET);
  expect(founderSharesBefore).toBeGreaterThanOrEqual(SHARES_MOVED);
  await founder.getByTestId("trading-sell").click();
  // More lots than the wallet may offer now: the page says how many it can, and sending sends nothing.
  const offerable =
    (await callWord(POLICY, `${SIG.saleCapacity}${word(FOUNDER_WALLET)}`)) /
    WAD;
  const offerableNow =
    offerable < founderSharesBefore / WAD
      ? offerable
      : founderSharesBefore / WAD;
  await expect(founder.getByTestId("trading-sell-room")).toContainText(
    `You can offer up to ${offerableNow} lots now`,
  );
  await founder
    .getByTestId("trading-sell-lots")
    .fill((offerableNow + 1n).toString());
  await founder.getByTestId("trading-sell-price").fill(LOW_TEXT);
  await founder.getByTestId("trading-sell-price").blur();
  await expect(founder.getByTestId("trading-sell-plan-problem")).toContainText(
    `You can offer up to ${offerableNow} lots now`,
  );
  await founder.getByTestId("trading-sell-submit").click();
  await expect(founder.getByTestId("trading-sell-lots")).toBeFocused();
  await expect(founder.getByTestId("trading-my-sell")).toHaveCount(0);
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
  // The bidder's page is left open and never reloaded: the card re-reads on its own while a round is live, so it
  // notices that bidding closed and tells the bidder its bid is waiting on someone to settle.
  await expect(bidder.getByTestId("trading-settle-notice")).toContainText(
    "Anyone can settle it",
    { timeout: 75_000 },
  );
  say("the bidder's open page noticed the round closing, with no reload");
  await founder.reload();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Bidding is over.",
    { timeout: 60_000 },
  );
  await expect(founder.getByTestId("trading-settle-notice")).toContainText(
    "costs only a network fee",
  );
  // No round has settled, so no price is shown and no label either.
  await expect(
    founder.getByTestId("trading-round").getByTestId("price-setter-note"),
  ).toHaveCount(0);
  await expect(founder.getByTestId("trading-settle")).toBeVisible();
  // While bidding is open there is no offer or bid left to place, and the round is settled by the button, not by time.
  await expect(founder.getByTestId("trading-sell")).toHaveCount(0);
  await expect(founder.getByTestId("trading-bid")).toHaveCount(0);
  await founder.getByTestId("trading-settle").click();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    `Settled: 2 lots traded at 1 ${QUOTE_SYMBOL} a lot`,
    { timeout: 90_000 },
  );
  await expectPriceLabel(founder);
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
  await activateByKeyboardAndKeepFocus(bidder, "trading-claim-shares");
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
  await activateByKeyboardAndKeepFocus(founder, "trading-claim-quote");
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
    `Settled: 2 lots traded at 1 ${QUOTE_SYMBOL} a lot`,
  );
  await expectPriceLabel(third);
  // The same on a phone: 375px wide, the label is still there, in full, under the price.
  await third.setViewportSize({ width: 375, height: 812 });
  await expectPriceLabel(third);
  await third.setViewportSize({ width: 1280, height: 720 });
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
  // The card stays on screen (a failed read does not replace it) and says which read it could not do.
  await expect(third.getByTestId("trading-state")).toContainText(
    "The market's price token couldn't be read just now, so no price can be shown.",
    { timeout: 60_000 },
  );
  // Nothing that would carry a price is shown, and no new offer or bid is taken without the token's units.
  await expect(third.getByTestId("trading-listing")).toHaveCount(0);
  await expect(third.getByTestId("trading-sell")).toHaveCount(0);
  await expect(third.getByTestId("trading-bid")).toHaveCount(0);
  await expect(third.getByTestId("trading-claim")).toHaveCount(0);
  // The way back is to read again, and it works once the token answers again.
  await third.unroute(quoteDown);
  await third.reload();
  await expect(third.getByTestId("trading-listing")).toBeVisible({
    timeout: 60_000,
  });
  await expect(third.getByTestId("trading-state")).not.toContainText(
    "price token couldn't be read",
  );
  say(
    "a price token that could not be read printed no price, and trying again found it",
  );

  await context.close();
});

test("a round nobody settled still pays out after the next round opens: each wallet collects it from the card", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const relay = createMockRelay();
  relay.seed(launchRecord());
  const say = (what: string) => console.log(`[trading] ${what}`);

  // The journey above left round 1 settled and collected. Run the whole file, not this test alone.
  expect(await callWord(MARKET, SIG.roundCount)).toBe(1n);

  // ── Round 2 opens a week after round 1 did, with one offer and one bid, and nobody settles it ────────────
  await passTime(5 * DAY);
  const founder = await personPage(
    context,
    relay,
    FOUNDER_WALLET,
    FOUNDER_NSEC,
  );
  await openTrading(founder);
  await expect(founder.getByTestId("trading-open")).toBeVisible({
    timeout: 60_000,
  });
  await founder.getByTestId("trading-open").click();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Offers and bids close",
    { timeout: 90_000 },
  );
  expect(await callWord(MARKET, SIG.roundCount)).toBe(2n);

  const founderSharesBefore = await balanceOf(SHARES, FOUNDER_WALLET);
  await founder.getByTestId("trading-sell").click();
  await founder.getByTestId("trading-sell-lots").fill(LOTS.toString());
  await founder.getByTestId("trading-sell-price").fill(LOW_TEXT);
  await founder.getByTestId("trading-sell-submit").click();
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "You offer 2 lots at",
    { timeout: 90_000 },
  );
  expect(await balanceOf(SHARES, FOUNDER_WALLET)).toBe(
    founderSharesBefore - SHARES_MOVED,
  );

  const bidder = await personPage(context, relay, BIDDER_WALLET, BIDDER_NSEC);
  await openTrading(bidder);
  await expect(bidder.getByTestId("trading-bid")).toBeVisible({
    timeout: 60_000,
  });
  const bidderQuoteBefore = await balanceOf(QUOTE, BIDDER_WALLET);
  await bidder.getByTestId("trading-bid").click();
  await bidder.getByTestId("trading-bid-lots").fill(LOTS.toString());
  await bidder.getByTestId("trading-bid-price").fill(HIGH_TEXT);
  await bidder.getByTestId("trading-bid-submit").click();
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "You bid for 2 lots at up to",
    { timeout: 90_000 },
  );
  expect(await balanceOf(QUOTE, BIDDER_WALLET)).toBe(
    bidderQuoteBefore - BID_ESCROW,
  );
  say("round 2 holds one offer and one bid");

  // ── Nobody settles: round 2 goes void, a week passes, and round 3 opens ─────────────────────────────────
  await passTime(7 * DAY + 60);
  await founder.reload();
  await expect(founder.getByTestId("trading-open")).toBeVisible({
    timeout: 60_000,
  });
  // While round 2 is the latest, its payout is the round's own (a void round owes both sides everything).
  await expect(founder.getByTestId("trading-claim-shares")).toBeVisible();
  await founder.getByTestId("trading-open").click();
  await expect
    .poll(() => callWord(MARKET, SIG.roundCount), { timeout: 90_000 })
    .toBe(3n);
  say("round 3 opened while round 2 still owes both sides");

  // ── The card still offers what round 2 owes: the page is on round 3, and round 3 owes this wallet nothing ──
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Offers and bids close",
    { timeout: 60_000 },
  );
  await expect(founder.getByTestId("trading-claim")).toHaveCount(0);
  await expect(founder.getByTestId("trading-earlier")).toBeVisible({
    timeout: 60_000,
  });
  await expect(founder.getByTestId("trading-earlier")).toContainText(
    "Collect from an earlier round",
  );
  await expect(founder.getByTestId("trading-earlier-round")).toHaveCount(1);
  // The seller is owed its own Shares back, and no money: nothing of its offer sold.
  await expect(
    founder.getByTestId("trading-earlier-claim-shares"),
  ).toContainText("Collect 2 Shares");
  await expect(founder.getByTestId("trading-earlier-claim-quote")).toHaveCount(
    0,
  );
  await activateByKeyboardAndKeepFocus(founder, "trading-earlier-claim-shares");
  await expect
    .poll(() => balanceOf(SHARES, FOUNDER_WALLET), { timeout: 90_000 })
    .toBe(founderSharesBefore);
  // Collected: the row is gone and the round's Shares ledger is empty.
  await expect(founder.getByTestId("trading-earlier")).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(2n)}`)).toBe(0n);

  await bidder.reload();
  await expect(bidder.getByTestId("trading-claim")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(bidder.getByTestId("trading-earlier")).toBeVisible({
    timeout: 60_000,
  });
  // The buyer is owed its whole bid back: the round never settled, so no price was set.
  await expect(bidder.getByTestId("trading-earlier-claim-quote")).toContainText(
    `Collect 130 ${QUOTE_SYMBOL}`,
  );
  await expect(bidder.getByTestId("trading-earlier-claim-shares")).toHaveCount(
    0,
  );
  await bidder.getByTestId("trading-earlier-claim-quote").click();
  await expect
    .poll(() => balanceOf(QUOTE, BIDDER_WALLET), { timeout: 90_000 })
    .toBe(bidderQuoteBefore);
  await expect(bidder.getByTestId("trading-earlier")).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(await callWord(MARKET, `${SIG.quoteIn}${word(2n)}`)).toBe(0n);
  say("both sides collected round 2 from the card while round 3 was open");

  await context.close();
});

test("a settled round where the offer and the bid never cross says nothing traded, and prints no price", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const relay = createMockRelay();
  relay.seed(launchRecord());
  const say = (what: string) => console.log(`[trading] ${what}`);

  // The journeys above left round 3 open and empty. Run the whole file, not this test alone.
  expect(await callWord(MARKET, SIG.roundCount)).toBe(3n);

  // ── One offer at the top of the grid, one bid at the bottom: they can never meet ─────────────────────────
  const founder = await personPage(
    context,
    relay,
    FOUNDER_WALLET,
    FOUNDER_NSEC,
  );
  await openTrading(founder);
  await expect(founder.getByTestId("trading-sell")).toBeVisible({
    timeout: 60_000,
  });
  const founderSharesBefore = await balanceOf(SHARES, FOUNDER_WALLET);
  await founder.getByTestId("trading-sell").click();
  await founder.getByTestId("trading-sell-lots").fill("1");
  await founder.getByTestId("trading-sell-price").fill(HIGH_TEXT);
  await founder.getByTestId("trading-sell-submit").click();
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "You offer 1 lot at",
    { timeout: 90_000 },
  );
  const bidder = await personPage(context, relay, BIDDER_WALLET, BIDDER_NSEC);
  await openTrading(bidder);
  await expect(bidder.getByTestId("trading-bid")).toBeVisible({
    timeout: 60_000,
  });
  const bidderQuoteBefore = await balanceOf(QUOTE, BIDDER_WALLET);
  await bidder.getByTestId("trading-bid").click();
  await bidder.getByTestId("trading-bid-lots").fill("1");
  await bidder.getByTestId("trading-bid-price").fill(LOW_TEXT);
  await bidder.getByTestId("trading-bid-submit").click();
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "You bid for 1 lot at up to",
    { timeout: 90_000 },
  );
  say("round 3 holds one offer at the top and one bid at the bottom");

  // ── Settle it: nothing matches, but the chain still stores level 0 and both totals stay non-zero ────────
  await passTime(3 * DAY + 60);
  await founder.reload();
  await expect(founder.getByTestId("trading-settle")).toBeVisible({
    timeout: 60_000,
  });
  await founder.getByTestId("trading-settle").click();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Settled.",
    { timeout: 90_000 },
  );
  const round = await callWords(MARKET, `${SIG.rounds}${word(3n)}`);
  expect(round[9]).toBe(1n); // settled
  expect(round[8]).toBe(0n); // the stored level is the grid's lowest step, a price nobody traded at
  expect(round[6]).toBe(1n); // asked: the open total, untouched by settling
  expect(round[7]).toBe(1n); // wanted
  // The page says what happened, and names no price for a trade that never was.
  await expect(founder.getByTestId("trading-round-status")).toHaveText(
    "Settled. Nothing crossed, so nothing traded.",
  );
  await expect(founder.getByTestId("trading-round-status")).not.toContainText(
    `${QUOTE_SYMBOL} a lot`,
  );
  // No price, so no label that would sit beside one.
  await expectHistory(founder, [
    { id: 2, outcome: "No trade" },
    { id: 1, outcome: `2 lots traded at 1 ${QUOTE_SYMBOL} a lot` },
  ]);
  await expect(
    founder.getByTestId("trading-round").getByTestId("price-setter-note"),
  ).toHaveCount(0);
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "Nothing sold: your Shares are yours to take back.",
  );
  await expect(founder.getByTestId("trading-my-sell")).not.toContainText(
    "round's price",
  );
  // Settling returns no Shares: the unsold lot is still in the market, and the seller takes it back with the card's
  // own button.
  expect(await balanceOf(SHARES, FOUNDER_WALLET)).toBe(
    founderSharesBefore - WAD,
  );
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(3n)}`)).toBe(WAD);
  await expect(founder.getByTestId("trading-claim-shares")).toContainText(
    "Collect 1 Share",
  );
  await expect(founder.getByTestId("trading-claim-quote")).toHaveCount(0);
  await activateByKeyboardAndKeepFocus(founder, "trading-claim-shares");
  await expect
    .poll(() => balanceOf(SHARES, FOUNDER_WALLET), { timeout: 90_000 })
    .toBe(founderSharesBefore);
  // Collected: the button is gone, the line says they are back, and the chain would pay nothing twice.
  await expect(founder.getByTestId("trading-claim-shares")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "Nothing sold: your Shares are back with you.",
  );
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(3n)}`)).toBe(0n);
  await expect(
    rpc("eth_call", [
      {
        from: THIRD_WALLET,
        to: MARKET,
        data: `${SIG.claimShares}${word(3n)}${word(FOUNDER_WALLET)}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();

  await bidder.reload();
  await expect(bidder.getByTestId("trading-round-status")).toHaveText(
    "Settled. Nothing crossed, so nothing traded.",
    { timeout: 60_000 },
  );
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "Nothing bought: your money is yours to collect.",
  );
  await expect(bidder.getByTestId("trading-my-bid")).not.toContainText(
    "round's price",
  );
  // The whole bid comes back by the card's own button.
  await expect(bidder.getByTestId("trading-claim-quote")).toBeVisible();
  await bidder.getByTestId("trading-claim-quote").click();
  await expect
    .poll(() => balanceOf(QUOTE, BIDDER_WALLET), { timeout: 90_000 })
    .toBe(bidderQuoteBefore);
  say("a round that matched nothing says so, and everyone has their own back");

  await context.close();
});

test("a seller whose offer part-sold takes back the unsold lots, from the card and then from an earlier round", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const relay = createMockRelay();
  relay.seed(launchRecord());
  const say = (what: string) => console.log(`[trading] ${what}`);

  // The journeys above left round 3 settled and collected. Run the whole file, not this test alone.
  expect(await callWord(MARKET, SIG.roundCount)).toBe(3n);

  // ── Round 4: the founder offers three lots, a second person bids for one ──────────────────────────────────
  await passTime(5 * DAY);
  const founder = await personPage(
    context,
    relay,
    FOUNDER_WALLET,
    FOUNDER_NSEC,
  );
  await openTrading(founder);
  await expect(founder.getByTestId("trading-open")).toBeVisible({
    timeout: 60_000,
  });
  await founder.getByTestId("trading-open").click();
  await expect
    .poll(() => callWord(MARKET, SIG.roundCount), { timeout: 90_000 })
    .toBe(4n);
  await expect(founder.getByTestId("trading-sell")).toBeVisible({
    timeout: 60_000,
  });
  const founderSharesBefore = await balanceOf(SHARES, FOUNDER_WALLET);
  await founder.getByTestId("trading-sell").click();
  await founder.getByTestId("trading-sell-lots").fill("3");
  await founder.getByTestId("trading-sell-price").fill(LATER_TEXT);
  await founder.getByTestId("trading-sell-submit").click();
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "You offer 3 lots at",
    { timeout: 90_000 },
  );
  const bidder = await personPage(context, relay, BIDDER_WALLET, BIDDER_NSEC);
  await openTrading(bidder);
  await expect(bidder.getByTestId("trading-bid")).toBeVisible({
    timeout: 60_000,
  });
  await bidder.getByTestId("trading-bid").click();
  await bidder.getByTestId("trading-bid-lots").fill("1");
  await bidder.getByTestId("trading-bid-price").fill(HIGH_TEXT);
  await bidder.getByTestId("trading-bid-submit").click();
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "You bid for 1 lot at up to",
    { timeout: 90_000 },
  );
  say("round 4 holds an offer of three lots and a bid for one");

  // ── Settle: one lot trades, and settling hands no Shares back ───────────────────────────────────────────
  await passTime(3 * DAY + 60);
  await founder.reload();
  await expect(founder.getByTestId("trading-settle")).toBeVisible({
    timeout: 60_000,
  });
  await founder.getByTestId("trading-settle").click();
  await expect(founder.getByTestId("trading-round-status")).toContainText(
    "Settled: 1 lot traded at",
    { timeout: 90_000 },
  );
  const sold = await callWords(
    MARKET,
    `${SIG.sells}${word(4n)}${word(FOUNDER_WALLET)}`,
  );
  expect(sold[0]).toBe(3n); // lots
  expect(sold[2]).toBe(1n); // filled: the bid wanted one
  expect(sold[4]).toBe(0n); // escrowReturned: settle returned nothing
  // The market still holds the unsold two lots and the buyer's one: the seller's wallet is three Shares down.
  expect(await balanceOf(SHARES, FOUNDER_WALLET)).toBe(
    founderSharesBefore - 3n * WAD,
  );
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(4n)}`)).toBe(3n * WAD);
  // The seller sees both what sold and what is left to take back, and is offered both collects.
  await expect(founder.getByTestId("trading-my-sell")).toContainText(
    "Sold: 1 lot at the round's price. 2 lots to take back.",
  );
  await expect(founder.getByTestId("trading-claim-shares")).toContainText(
    "Collect 2 Shares",
  );
  await expect(founder.getByTestId("trading-claim-quote")).toBeVisible();
  say("the part-filled seller is offered the unsold lots as Shares to collect");

  // ── Collect the proceeds from the card, then the round is no longer the latest ──────────────────────────
  // One lot sold at the round's own clearing price: its lowest price plus the stored level times a step.
  const record = await callWords(MARKET, `${SIG.rounds}${word(4n)}`);
  const proceeds = record[0] + record[8] * record[1];
  const founderQuoteBefore = await balanceOf(QUOTE, FOUNDER_WALLET);
  await founder.getByTestId("trading-claim-quote").click();
  await expect
    .poll(() => balanceOf(QUOTE, FOUNDER_WALLET), { timeout: 90_000 })
    .toBe(founderQuoteBefore + proceeds);
  await expect(founder.getByTestId("trading-claim-quote")).toHaveCount(0, {
    timeout: 60_000,
  });
  // The unsold lots are still the seller's to take back: collecting the money did not touch them.
  await expect(founder.getByTestId("trading-claim-shares")).toContainText(
    "Collect 2 Shares",
  );
  await passTime(5 * DAY);
  await founder.reload();
  await expect(founder.getByTestId("trading-open")).toBeVisible({
    timeout: 60_000,
  });
  await founder.getByTestId("trading-open").click();
  await expect
    .poll(() => callWord(MARKET, SIG.roundCount), { timeout: 90_000 })
    .toBe(5n);

  // ── Round 5 is the latest; the settled round 4 still owes the seller, and a claim never expires ─────────
  // The Earlier rounds list: newest first, both traded rounds with their own lots and price, the rounds nothing
  // traded in as "No trade", and the permanent label once under the list, on a phone as well.
  expect(proceeds).toBe(5n * WAD); // round 4 settled at the offer's own price, read off the chain
  const history = [
    { id: 4, outcome: `1 lot traded at 5 ${QUOTE_SYMBOL} a lot` },
    { id: 3, outcome: "No trade" },
    { id: 2, outcome: "No trade" },
    { id: 1, outcome: `2 lots traded at 1 ${QUOTE_SYMBOL} a lot` },
  ];
  await expectHistory(founder, history);
  await founder.setViewportSize({ width: 375, height: 812 });
  await expectHistory(founder, history);
  await founder.setViewportSize({ width: 1280, height: 720 });
  await expect(founder.getByTestId("trading-claim")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(founder.getByTestId("trading-earlier")).toBeVisible({
    timeout: 60_000,
  });
  await expect(founder.getByTestId("trading-earlier-round")).toHaveCount(1);
  await expect(
    founder.getByTestId("trading-earlier-claim-shares"),
  ).toContainText("Collect 2 Shares");
  await expect(founder.getByTestId("trading-earlier-claim-quote")).toHaveCount(
    0,
  );
  await founder.getByTestId("trading-earlier-claim-shares").click();
  await expect
    .poll(() => balanceOf(SHARES, FOUNDER_WALLET), { timeout: 90_000 })
    .toBe(founderSharesBefore - WAD);
  const returned = await callWords(
    MARKET,
    `${SIG.sells}${word(4n)}${word(FOUNDER_WALLET)}`,
  );
  expect(returned[4]).toBe(1n); // escrowReturned
  // Collected: the row is gone, only the buyer's lot is left in the round, and a repeat would pay nothing.
  await expect(founder.getByTestId("trading-earlier")).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(4n)}`)).toBe(WAD);
  await expect(
    rpc("eth_call", [
      {
        from: THIRD_WALLET,
        to: MARKET,
        data: `${SIG.claimShares}${word(4n)}${word(FOUNDER_WALLET)}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();
  say("the part-filled seller took back the unsold lots from an earlier round");

  // ── The buyer collects its lot and the round's ledgers end at zero ───────────────────────────────────────
  await bidder.reload();
  const bidderSharesBefore = await balanceOf(SHARES, BIDDER_WALLET);
  await expect(bidder.getByTestId("trading-earlier-claim-shares")).toBeVisible({
    timeout: 60_000,
  });
  await bidder.getByTestId("trading-earlier-claim-shares").click();
  await expect
    .poll(() => balanceOf(SHARES, BIDDER_WALLET), { timeout: 90_000 })
    .toBe(bidderSharesBefore + WAD);
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(4n)}`)).toBe(0n);
  expect(await balanceOf(SHARES, MARKET)).toBe(0n);
  say("the buyer collected its lot and round 4 holds nothing");

  await context.close();
});

/** A wallet that answers every chain question with chain 1: the page is on the local chain, so the send is gated. */
async function onWrongNetwork(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const provider = (
      window as unknown as {
        ethereum: {
          request: (a: {
            method: string;
            params?: unknown[];
          }) => Promise<unknown>;
        };
      }
    ).ethereum;
    const real = provider.request.bind(provider);
    provider.request = (args) =>
      args.method === "eth_chainId" ? Promise.resolve("0x1") : real(args);
  });
}

test("trading by keyboard and screen reader: focus follows the form, Enter sends, the result is announced, a wrong network says why", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const relay = createMockRelay();
  relay.seed(launchRecord());
  const say = (what: string) => console.log(`[trading] ${what}`);

  // The journeys above left round 5 open for bids, with no order from the founder or the buyer in it.
  expect(await callWord(MARKET, SIG.roundCount)).toBe(5n);

  // ── The offer form, by keyboard alone ──────────────────────────────────────────────────────────────────
  const founder = await personPage(
    context,
    relay,
    FOUNDER_WALLET,
    FOUNDER_NSEC,
  );
  await openTrading(founder);
  const trigger = founder.getByTestId("trading-sell");
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus();
  await founder.keyboard.press("Enter");
  // Opening the form puts the cursor in it (a screen reader hears the first field), and the trigger stays as the toggle.
  await expect(founder.getByTestId("trading-sell-lots")).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const controls = await trigger.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  await expect(founder.locator(`[id="${controls}"]`)).toBeVisible();
  // The copy button's accessible name starts with its visible words (label in name), then says which token.
  await expect(founder.getByTestId("quote-token-copy")).toHaveAccessibleName(
    /^Copy address\b.*\b0x[0-9a-f]{4}/i,
  );
  // The plan and problem text lives in one polite region that is in the page before it says anything.
  const live = founder.getByTestId("trading-sell-plan-live");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveText("");

  // Tab walks lots, price, the send button (it stays reachable while the plan is unfinished, so Enter on it can say
  // what is missing), then Cancel; Enter on Cancel closes the form and hands focus back to the trigger.
  await founder.keyboard.press("Tab");
  await expect(founder.getByTestId("trading-sell-price")).toBeFocused();
  await founder.keyboard.press("Tab");
  await expect(founder.getByTestId("trading-sell-submit")).toBeFocused();
  await expect(founder.getByTestId("trading-sell-submit")).toBeEnabled();
  await founder.keyboard.press("Tab");
  await expect(founder.getByTestId("trading-sell-cancel")).toBeFocused();
  await founder.keyboard.press("Enter");
  await expect(founder.getByTestId("trading-sell-form")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  say(
    "the offer form takes focus when opened and gives it back when cancelled",
  );

  // ── Enter with a plan that does not hold says why, marks the field and sends nothing ────────────────────
  await founder.keyboard.press("Enter");
  await expect(founder.getByTestId("trading-sell-lots")).toBeFocused();
  await expectEnterSaysWhy(founder, "trading-sell", {
    lots: "0",
    price: "1",
    problem: "at least one whole lot",
    invalid: "trading-sell-lots",
  });
  await expectEnterSaysWhy(founder, "trading-sell", {
    lots: "1",
    price: "abc",
    problem: "a number like 1.05",
    invalid: "trading-sell-price",
  });
  // Nothing was sent: no order line, and the market still holds none of the round's Shares.
  await expect(founder.getByTestId("trading-my-sell")).toHaveCount(0);
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(5n)}`)).toBe(0n);
  await founder.getByTestId("trading-sell-cancel").click();
  await expect(trigger).toBeFocused();
  say(
    "Enter on an unfinished offer says why, marks the field and sends nothing",
  );

  // ── Typing: a comma is a decimal point; an unfinished price is not shouted at ──────────────────────────
  await founder.keyboard.press("Enter");
  await expect(founder.getByTestId("trading-sell-lots")).toBeFocused();
  await founder.keyboard.type("1");
  await founder.keyboard.press("Tab");
  await founder.keyboard.type("1.");
  // Mid-typing: nothing is announced or marked wrong yet.
  await expect(founder.getByTestId("trading-sell-plan-problem")).toHaveCount(0);
  await expect(founder.getByTestId("trading-sell-price")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
  // Leaving the field says what is wrong, in a role-less polite region, and marks the field.
  await founder.keyboard.press("Tab");
  await expect(founder.getByTestId("trading-sell-plan-problem")).toContainText(
    "a number like 1.05",
  );
  await expect(
    founder.getByTestId("trading-sell-plan-problem"),
  ).not.toHaveAttribute("role", "alert");
  await expect(founder.getByTestId("trading-sell-price")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  const statusId = await live.getAttribute("id");
  expect(statusId).toBeTruthy();
  const described = await founder
    .getByTestId("trading-sell-price")
    .getAttribute("aria-describedby");
  expect(described ?? "").toContain(statusId ?? "never");
  expect(described ?? "").toContain(
    (await founder.getByTestId("trading-sell-room").getAttribute("id")) ??
      "never",
  );
  // A decimal comma is accepted, and the valid plan is said in the same region.
  await founder.getByTestId("trading-sell-price").fill("1,05");
  await expect(founder.getByTestId("trading-sell-plan-problem")).toHaveCount(0);
  await expect(live).toContainText("This holds 1 lot (1 Share)");
  await expect(founder.getByTestId("trading-sell-price")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );

  // ── Enter in a field sends (a real form), and the result takes focus ───────────────────────────────────
  await founder.getByTestId("trading-sell-price").focus();
  await founder.keyboard.press("Enter");
  const mine = founder.getByTestId("trading-my-sell");
  await expect(mine).toContainText("You offer 1 lot at", { timeout: 90_000 });
  await expect(mine).toBeFocused();
  await expect(mine).toHaveAttribute("tabindex", "-1");
  // The order lines sit in a polite region that was in the page before the order existed.
  await expect(
    founder.locator('[data-testid="trading-orders"][aria-live="polite"]'),
  ).toHaveCount(1);
  expect(await callWord(MARKET, `${SIG.sharesIn}${word(5n)}`)).toBe(WAD);
  say(
    "Enter sent the offer, a decimal comma was understood, and focus moved to the result",
  );

  // ── The bid form, by keyboard alone ────────────────────────────────────────────────────────────────────
  const bidder = await personPage(context, relay, BIDDER_WALLET, BIDDER_NSEC);
  await openTrading(bidder);
  const bidTrigger = bidder.getByTestId("trading-bid");
  await expect(bidTrigger).toBeVisible({ timeout: 60_000 });
  await bidTrigger.focus();
  await bidder.keyboard.press("Space");
  await expect(bidder.getByTestId("trading-bid-lots")).toBeFocused();
  await expect(bidTrigger).toHaveAttribute("aria-expanded", "true");
  await expectEnterSaysWhy(bidder, "trading-bid", {
    lots: "",
    price: "",
    problem: "whole number of lots",
    invalid: "trading-bid-lots",
  });
  await expectEnterSaysWhy(bidder, "trading-bid", {
    lots: "0",
    price: "1",
    problem: "at least one whole lot",
    invalid: "trading-bid-lots",
  });
  await expectEnterSaysWhy(bidder, "trading-bid", {
    lots: "1",
    price: "abc",
    problem: "a number like 1.05",
    invalid: "trading-bid-price",
  });
  await expect(bidder.getByTestId("trading-my-bid")).toHaveCount(0);
  // Cancel and open it afresh: a form that has been told off starts clean.
  await bidder.getByTestId("trading-bid-cancel").click();
  await expect(bidTrigger).toBeFocused();
  await bidder.keyboard.press("Space");
  await expect(bidder.getByTestId("trading-bid-lots")).toBeFocused();
  await bidder.keyboard.type("1");
  await bidder.keyboard.press("Tab");
  await bidder.keyboard.type(HIGH_TEXT);
  await bidder.keyboard.press("Enter");
  await expect(bidder.getByTestId("trading-my-bid")).toContainText(
    "You bid for 1 lot at up to",
    { timeout: 90_000 },
  );
  await expect(bidder.getByTestId("trading-my-bid")).toBeFocused();
  say("the bid form takes focus, Enter sends it, and the result takes focus");

  // ── A wrong network is said, and the disabled buttons point at the reason ──────────────────────────────
  const away = await context.newPage();
  await relay.install(away);
  await installAnvilWallet(away, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await onWrongNetwork(away);
  await away.addInitScript(
    ([key, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", key);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [FOUNDER_NSEC, ANVIL_URL],
  );
  await openTrading(away);
  const gate = away.getByTestId("trading-gate");
  await expect(gate).toContainText("Switch networks in your wallet", {
    timeout: 60_000,
  });
  const gateId = await gate.getAttribute("id");
  expect(gateId).toBeTruthy();
  const cancel = away.getByTestId("trading-cancel-sell");
  await expect(cancel).toBeDisabled();
  expect((await cancel.getAttribute("aria-describedby")) ?? "").toContain(
    gateId ?? "never",
  );
  say("a wallet on another network is told why every button is off");

  await context.close();
});
