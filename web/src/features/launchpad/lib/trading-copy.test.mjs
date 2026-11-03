import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bidHolds,
  bidOrderLine,
  bidPlan,
  claimDue,
  factoryMissingLine,
  listingDetailLine,
  listingTermsLine,
  lotPriceLine,
  lotSizeLine,
  lots,
  money,
  nextRoundChip,
  nextRoundLine,
  roundLine,
  sellHolds,
  sellOrderLine,
  sellPlan,
  shareUnits,
  stepAtLeast,
  stepAtMost,
  tradingStateLine,
  unreadableLine,
} from "./trading-copy.ts";

const USD = 1_000_000n;
const E18 = 10n ** 18n;
const LOT = 100n * E18;

// Midday UTC, so a date is the same day in every time zone the tests run in.
const OCT_14 = Date.UTC(2026, 9, 14, 12) / 1000;
const OCT_17 = Date.UTC(2026, 9, 17, 12) / 1000;
const OCT_19 = Date.UTC(2026, 9, 19, 12) / 1000;

const listing = {
  enabled: true,
  minPrice: USD,
  maxPrice: 1_064_000n,
  levels: 8,
};

const round = (over = {}) => ({
  minPrice: USD,
  step: 8_000n,
  levels: 8,
  opensAt: OCT_14,
  closesAt: OCT_17,
  settleDeadline: OCT_19,
  asked: 3n,
  wanted: 5n,
  price: 0,
  settled: false,
  sellersShare: false,
  phase: "bidding",
  ...over,
});

const sell = (over = {}) => ({
  lots: 2n,
  minStep: 0,
  filled: 0n,
  orderId: 1n,
  escrowReturned: false,
  proceedsPaid: false,
  ...over,
});

const bid = (over = {}) => ({
  lots: 5n,
  maxStep: 4,
  filled: 0n,
  orderId: 2n,
  cancelled: false,
  sharesPaid: false,
  refundDone: false,
  ...over,
});

const WALLET = `0x${"be".repeat(20)}`;
const market = (over = {}) => ({
  kind: "present",
  market: `0x${"3a".repeat(20)}`,
  listing,
  round: null,
  wallet: { address: WALLET, sell: null, bid: null },
  ...over,
});

test("money, lots and Shares read as plain figures", () => {
  assert.equal(money(USD), "1 USDC");
  assert.equal(money(1_064_000n), "1.064 USDC");
  assert.equal(lots(1n), "1 lot");
  assert.equal(lots(3n), "3 lots");
  assert.equal(shareUnits(LOT), "100");
});

test("no market, no listing and a listing that is on are told apart", () => {
  assert.match(
    tradingStateLine({ kind: "absent" }, OCT_14),
    /has no secondary market/,
  );
  const off = tradingStateLine(
    market({ listing: { ...listing, enabled: false } }),
    OCT_14,
  );
  assert.match(off, /Trading is off: the DAO has no open listing\./);
  assert.match(off, /Opening one is the DAO's decision\./);
  const on = tradingStateLine(market({ round: round() }), OCT_14);
  assert.equal(
    on,
    "Trading is on: from 1 USDC to 1.064 USDC a lot, in 8 steps. A round is taking offers and bids now.",
  );
});

test("a listing that is on names the round's phase, and the next opening when there is one", () => {
  assert.match(
    tradingStateLine(market(), OCT_14),
    /No round has opened yet\.$/,
  );
  assert.match(
    tradingStateLine(market({ round: round({ phase: "settling" }) }), OCT_17),
    /A round is waiting to be settled\.$/,
  );
  assert.match(
    tradingStateLine(market({ round: round({ phase: "void" }) }), OCT_19),
    /went void/,
  );
  // A settled round inside the week since it opened names when the next one may open.
  const settled = tradingStateLine(
    market({ round: round({ phase: "settled", settled: true }) }),
    OCT_17,
  );
  assert.match(settled, /The latest round has settled\./);
  assert.match(settled, /Next round from Oct 21/);
  // A week after it opened, the cadence allows another one: no waiting line.
  assert.doesNotMatch(
    tradingStateLine(
      market({ round: round({ phase: "settled", settled: true }) }),
      OCT_14 + 7 * 86_400,
    ),
    /Next round from/,
  );
});

test("an unreadable read never reads as a DAO with no market", () => {
  const line = tradingStateLine(
    { kind: "unreadable", reason: "the node timed out" },
    OCT_14,
  );
  assert.match(line, /couldn't be read/);
  assert.doesNotMatch(line, /has no secondary market/i);
  assert.doesNotMatch(line, /no market/i);
  assert.equal(line, unreadableLine());
  assert.match(factoryMissingLine(), /isn't set up on this network/);
});

test("a round's status carries its deadline, and a settled one its price", () => {
  assert.match(roundLine(round()), /^Offers and bids close Oct 17/);
  assert.match(
    roundLine(round({ phase: "settling" })),
    /^Bidding is over\. Anyone can settle it until Oct 19/,
  );
  assert.equal(
    roundLine(round({ phase: "settled", settled: true, price: 2 })),
    "Settled at 1.016 USDC a lot, after offers closed Oct 17. Everyone collects their own result.",
  );
  assert.equal(
    roundLine(
      round({ phase: "settled", settled: true, asked: 0n, wanted: 0n }),
    ),
    "Settled. Nothing traded: everyone takes back theirs.",
  );
  assert.match(roundLine(round({ phase: "void" })), /everyone takes back/);
  assert.equal(roundLine(round({ phase: "none" })), "No round has opened yet.");
});

test("a lot's price comes from the round's frozen grid", () => {
  assert.equal(lotPriceLine(round(), 0), "1 USDC a lot at step 0 of 8");
  assert.equal(lotPriceLine(round(), 4), "1.032 USDC a lot at step 4 of 8");
  assert.equal(lotPriceLine(round(), 8), "1.064 USDC a lot at step 8 of 8");
  assert.equal(
    listingTermsLine(listing),
    "from 1 USDC to 1.064 USDC a lot, in 8 steps",
  );
  assert.equal(
    listingDetailLine(listing, LOT),
    "A lot is 100 Shares. Each step is 0.008 USDC apart.",
  );
  assert.equal(lotSizeLine(LOT), "A lot is 100 Shares.");
  assert.match(nextRoundLine(OCT_14 + 7 * 86_400), /^Next round from Oct 21/);
  // A chip carries no full stop; the sentence does.
  assert.doesNotMatch(nextRoundChip(OCT_14 + 7 * 86_400), /\.$/);
  assert.match(nextRoundLine(OCT_14 + 7 * 86_400), /\.$/);
});

test("a typed price becomes the step at or above it (a seller) or at or below it (a buyer)", () => {
  assert.equal(stepAtLeast(round(), 900_000n), 0);
  assert.equal(stepAtLeast(round(), USD), 0);
  assert.equal(stepAtLeast(round(), 1_004_000n), 1);
  assert.equal(stepAtLeast(round(), 1_008_000n), 1);
  assert.equal(stepAtLeast(round(), 1_009_000n), 2);
  assert.equal(stepAtLeast(round(), 1_064_000n), 8);
  assert.equal(stepAtLeast(round(), 1_065_000n), null);

  assert.equal(stepAtMost(round(), 900_000n), null);
  assert.equal(stepAtMost(round(), USD), 0);
  assert.equal(stepAtMost(round(), 1_007_000n), 0);
  assert.equal(stepAtMost(round(), 1_064_000n), 8);
  assert.equal(stepAtMost(round(), 2n * USD), 8);
});

test("the two order forms say what is wrong before anything is sent", () => {
  assert.deepEqual(sellPlan(round(), "2", "1.008"), { lots: 2n, level: 1 });
  assert.match(sellPlan(round(), "0", "1").problem, /at least one whole lot/);
  assert.match(sellPlan(round(), "1.5", "1").problem, /whole number of lots/);
  assert.match(
    sellPlan(round(), "1", "1.1").problem,
    /above this round's highest/,
  );
  assert.deepEqual(bidPlan(round(), "2", "1.05"), { lots: 2n, level: 6 });
  assert.match(
    bidPlan(round(), "2", "0.9").problem,
    /Bid at least 1 USDC a lot/,
  );
  assert.match(bidPlan(round(), "2", "1.0000001").problem, /decimal places/);
});

test("an order's escrow is whole lots at its step's price", () => {
  assert.equal(sellHolds(3n, LOT), 300n * E18);
  assert.equal(bidHolds(round(), 5n, 4), 5n * 1_032_000n);
});

test("what a finished round owes a wallet: proceeds, refunds, and Shares", () => {
  const settled = round({ phase: "settled", settled: true, price: 2 });
  // A seller's proceeds at the clearing price, and a buyer's refund above it.
  assert.deepEqual(
    claimDue(settled, { sell: sell({ filled: 2n }), bid: null }, LOT),
    { shares: 0n, quote: 2n * 1_016_000n },
  );
  assert.deepEqual(
    claimDue(
      settled,
      { sell: null, bid: bid({ lots: 5n, maxStep: 4, filled: 3n }) },
      LOT,
    ),
    { shares: 3n * LOT, quote: 5n * 1_032_000n - 3n * 1_016_000n },
  );
  // Already collected: nothing left.
  assert.deepEqual(
    claimDue(
      settled,
      {
        sell: sell({ filled: 2n, proceedsPaid: true }),
        bid: bid({ filled: 3n, sharesPaid: true, refundDone: true }),
      },
      LOT,
    ),
    { shares: 0n, quote: 0n },
  );
});

test("a void round gives back both sides' escrow", () => {
  assert.deepEqual(
    claimDue(
      round({ phase: "void" }),
      { sell: sell({ lots: 3n }), bid: bid({ lots: 2n, maxStep: 1 }) },
      LOT,
    ),
    { shares: 3n * LOT, quote: 2n * 1_008_000n },
  );
});

test("a live bid owes nothing yet, and a taken-back bid owes its escrow", () => {
  assert.deepEqual(claimDue(round(), { sell: sell(), bid: bid() }, LOT), {
    shares: 0n,
    quote: 0n,
  });
  assert.deepEqual(
    claimDue(
      round(),
      { sell: null, bid: bid({ lots: 2n, maxStep: 1, cancelled: true }) },
      LOT,
    ),
    { shares: 0n, quote: 2n * 1_008_000n },
  );
});

test("a wallet's own orders read as sentences, before and after the result", () => {
  assert.equal(
    sellOrderLine(round(), sell({ lots: 2n, minStep: 1, filled: 1n })),
    "You offer 2 lots at 1.008 USDC a lot or more.",
  );
  assert.equal(
    sellOrderLine(
      round({ phase: "settled" }),
      sell({ lots: 2n, minStep: 1, filled: 1n }),
    ),
    "You offer 2 lots at 1.008 USDC a lot or more. Sold: 1 lot at the round's price.",
  );
  assert.match(
    bidOrderLine(round(), bid({ cancelled: true })),
    /money is yours to collect/,
  );
  assert.equal(
    bidOrderLine(round(), bid({ lots: 2n, maxStep: 1 })),
    "You bid for 2 lots at up to 1.008 USDC a lot.",
  );
});
