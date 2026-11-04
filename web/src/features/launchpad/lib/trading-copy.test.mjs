import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bidHolds,
  bidOrderLine,
  bidPlan,
  claimDue,
  earlierDues,
  earlierLimitLine,
  earlierRoundLine,
  factoryMissingLine,
  listingDetailLine,
  LIVE_REFRESH_MS,
  listingTermsLine,
  lotPriceLine,
  lotSizeLine,
  lots,
  money,
  nextRoundChip,
  nextRoundLine,
  refreshEveryMs,
  roundLine,
  sellHolds,
  sellOrderLine,
  sellPlan,
  settleNoticeLine,
  shareUnits,
  stepAtLeast,
  stepAtMost,
  tokenUnreadableLine,
  tradingStateLine,
  unreadableLine,
} from "./trading-copy.ts";

const USD = 1_000_000n;
const E18 = 10n ** 18n;
const LOT = 100n * E18;

/** The quote token a six-decimal stablecoin is: what every sentence here was written for. */
const USDC = { quoteDecimals: 6, quoteSymbol: "USDC" };
/** The quote token the local fixture launches: eighteen decimals, and its own symbol. */
const FQ = { quoteDecimals: 18, quoteSymbol: "FQ" };

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
  matched: 0n,
  ...over,
});

/** The same grid on an eighteen-decimal quote: 1 to 65 whole tokens a lot, one token a step. */
const wideListing = {
  enabled: true,
  minPrice: E18,
  maxPrice: 65n * E18,
  levels: 64,
};

const wideRound = (over = {}) => ({
  minPrice: E18,
  step: E18,
  levels: 64,
  opensAt: OCT_14,
  closesAt: OCT_17,
  settleDeadline: OCT_19,
  asked: 2n,
  wanted: 2n,
  price: 0,
  settled: false,
  sellersShare: false,
  phase: "bidding",
  matched: 0n,
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
  assert.equal(money(USD, USDC), "1 USDC");
  assert.equal(money(1_064_000n, USDC), "1.064 USDC");
  assert.equal(lots(1n), "1 lot");
  assert.equal(lots(3n), "3 lots");
  assert.equal(shareUnits(LOT), "100");
});

test("a price is written at the quote token's own scale, whatever its decimals", () => {
  // Eighteen decimals: one whole token is 1e18 base units, and it reads as one token — never as a trillion of them.
  assert.equal(money(E18, FQ), "1 FQ");
  assert.equal(money(65n * E18, FQ), "65 FQ");
  assert.equal(money(1_064_000_000_000_000_000n, FQ), "1.064 FQ");
  // The smallest unit a token can name still has a figure, rather than rounding to nothing.
  assert.equal(money(1n, FQ), "0.000000000000000001 FQ");
  // The same base units are different money on a six-decimal token: the scale is the token's, not a constant.
  assert.equal(money(1_000_000n, FQ), "0.000000000001 FQ");
  assert.equal(money(1_000_000n, USDC), "1 USDC");
  // And every sentence that carries a price carries that scale with it.
  assert.equal(lotPriceLine(wideRound(), 0, FQ), "1 FQ a lot at step 0 of 64");
  assert.equal(
    lotPriceLine(wideRound(), 64, FQ),
    "65 FQ a lot at step 64 of 64",
  );
  assert.equal(
    listingTermsLine(wideListing, FQ),
    "from 1 FQ to 65 FQ a lot, in 64 steps",
  );
  assert.equal(
    listingDetailLine(wideListing, E18, FQ),
    "A lot is 1 Shares. Each step is 1 FQ apart.",
  );
  assert.equal(
    roundLine(wideRound({ phase: "settled", settled: true, matched: 2n }), FQ),
    "Settled: 2 lots traded at 1 FQ a lot, after offers closed Oct 17. Everyone collects their own result.",
  );
  assert.equal(
    sellOrderLine(wideRound(), sell({ lots: 2n }), FQ),
    "You offer 2 lots at 1 FQ a lot or more.",
  );
});

test("no market, no listing and a listing that is on are told apart", () => {
  assert.match(
    tradingStateLine({ kind: "absent" }, OCT_14, null),
    /has no secondary market/,
  );
  const off = tradingStateLine(
    market({ listing: { ...listing, enabled: false } }),
    OCT_14,
    USDC,
  );
  assert.match(off, /Trading is off: the DAO has no open listing\./);
  assert.match(off, /Opening one is the DAO's decision\./);
  const on = tradingStateLine(market({ round: round() }), OCT_14, USDC);
  assert.equal(
    on,
    "Trading is on: from 1 USDC to 1.064 USDC a lot, in 8 steps. A round is taking offers and bids now.",
  );
  // A listing that is on cannot state its terms without the token's own scale: that is said as a read we do not have,
  // never printed at a guessed one.
  assert.equal(
    tradingStateLine(market({ round: round() }), OCT_14, null),
    unreadableLine(),
  );
});

test("a token that cannot be read prints no price at all", () => {
  const line = tokenUnreadableLine();
  assert.match(line, /price token/);
  assert.match(line, /couldn't be read/);
  assert.match(line, /Reload to try again/);
  // It names no unit it did not read, and prints no figure.
  assert.doesNotMatch(line, /USDC/);
  assert.doesNotMatch(line, /\d/);
  // The unreadable market and the unreadable token are different sentences: one is about the market, one the scale.
  assert.notEqual(line, unreadableLine());
});

test("a listing that is on names the round's phase, and the next opening when there is one", () => {
  assert.match(
    tradingStateLine(market(), OCT_14, USDC),
    /No round has opened yet\.$/,
  );
  assert.match(
    tradingStateLine(
      market({ round: round({ phase: "settling" }) }),
      OCT_17,
      USDC,
    ),
    /A round is waiting to be settled\.$/,
  );
  assert.match(
    tradingStateLine(market({ round: round({ phase: "void" }) }), OCT_19, USDC),
    /went void/,
  );
  // A settled round inside the week since it opened names when the next one may open.
  const settled = tradingStateLine(
    market({ round: round({ phase: "settled", settled: true }) }),
    OCT_17,
    USDC,
  );
  assert.match(settled, /The latest round has settled\./);
  assert.match(settled, /Next round from Oct 21/);
  // A week after it opened, the cadence allows another one: no waiting line.
  assert.doesNotMatch(
    tradingStateLine(
      market({ round: round({ phase: "settled", settled: true }) }),
      OCT_14 + 7 * 86_400,
      USDC,
    ),
    /Next round from/,
  );
});

test("an unreadable read never reads as a DAO with no market", () => {
  const line = tradingStateLine(
    { kind: "unreadable", reason: "the node timed out" },
    OCT_14,
    null,
  );
  assert.match(line, /couldn't be read/);
  assert.doesNotMatch(line, /has no secondary market/i);
  assert.doesNotMatch(line, /no market/i);
  assert.equal(line, unreadableLine());
  assert.match(factoryMissingLine(), /isn't set up on this network/);
});

test("a round's status carries its deadline, and a settled one its price", () => {
  assert.match(roundLine(round(), USDC), /^Offers and bids close Oct 17/);
  assert.match(
    roundLine(round({ phase: "settling" }), USDC),
    /^Bidding is over\. Anyone can settle it until Oct 19/,
  );
  assert.equal(
    roundLine(
      round({ phase: "settled", settled: true, price: 2, matched: 2n }),
      USDC,
    ),
    "Settled: 2 lots traded at 1.016 USDC a lot, after offers closed Oct 17. Everyone collects their own result.",
  );
  assert.match(
    roundLine(round({ phase: "void" }), USDC),
    /everyone takes back/,
  );
  assert.equal(
    roundLine(round({ phase: "none" }), USDC),
    "No round has opened yet.",
  );
});

test("a settled round that matched nothing never prints a price", () => {
  const NOTHING = "Settled. Nothing crossed, so nothing traded.";
  // Orders on both sides that do not cross: asked and wanted are running totals of the open orders, so they
  // are not zero, but no lot changed hands. The old line printed the lowest price of the grid here.
  assert.equal(
    roundLine(
      round({
        phase: "settled",
        settled: true,
        asked: 1n,
        wanted: 1n,
        matched: 0n,
      }),
      USDC,
    ),
    NOTHING,
  );
  // Offers only, and bids only.
  assert.equal(
    roundLine(
      round({
        phase: "settled",
        settled: true,
        asked: 3n,
        wanted: 0n,
        matched: 0n,
      }),
      USDC,
    ),
    NOTHING,
  );
  assert.equal(
    roundLine(
      round({
        phase: "settled",
        settled: true,
        asked: 0n,
        wanted: 4n,
        matched: 0n,
      }),
      USDC,
    ),
    NOTHING,
  );
  // Nothing at all was offered or bid: the same plain answer, whatever the stored price.
  assert.equal(
    roundLine(
      round({ phase: "settled", settled: true, asked: 0n, wanted: 0n }),
      USDC,
    ),
    NOTHING,
  );
});

test("a settled round that traded says how much, next to the price", () => {
  // One lot, a one-lot round: the volume is part of the sentence, singular.
  assert.equal(
    roundLine(
      round({
        phase: "settled",
        settled: true,
        price: 2,
        asked: 1n,
        wanted: 1n,
        matched: 1n,
      }),
      USDC,
    ),
    "Settled: 1 lot traded at 1.016 USDC a lot, after offers closed Oct 17. Everyone collects their own result.",
  );
  assert.equal(
    roundLine(
      round({
        phase: "settled",
        settled: true,
        price: 2,
        asked: 5n,
        wanted: 3n,
        matched: 3n,
      }),
      USDC,
    ),
    "Settled: 3 lots traded at 1.016 USDC a lot, after offers closed Oct 17. Everyone collects their own result.",
  );
  // Level zero is a real price when something traded at it.
  assert.match(
    roundLine(
      round({
        phase: "settled",
        settled: true,
        price: 0,
        asked: 2n,
        wanted: 2n,
        matched: 2n,
      }),
      USDC,
    ),
    /^Settled: 2 lots traded at 1 USDC a lot/,
  );
});

test("a lot's price comes from the round's frozen grid", () => {
  assert.equal(lotPriceLine(round(), 0, USDC), "1 USDC a lot at step 0 of 8");
  assert.equal(
    lotPriceLine(round(), 4, USDC),
    "1.032 USDC a lot at step 4 of 8",
  );
  assert.equal(
    lotPriceLine(round(), 8, USDC),
    "1.064 USDC a lot at step 8 of 8",
  );
  assert.equal(
    listingTermsLine(listing, USDC),
    "from 1 USDC to 1.064 USDC a lot, in 8 steps",
  );
  assert.equal(
    listingDetailLine(listing, LOT, USDC),
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
  assert.deepEqual(sellPlan(round(), "2", "1.008", USDC), {
    lots: 2n,
    level: 1,
  });
  assert.match(
    sellPlan(round(), "0", "1", USDC).problem,
    /at least one whole lot/,
  );
  assert.match(
    sellPlan(round(), "1.5", "1", USDC).problem,
    /whole number of lots/,
  );
  assert.match(
    sellPlan(round(), "1", "1.1", USDC).problem,
    /above this round's highest/,
  );
  assert.deepEqual(bidPlan(round(), "2", "1.05", USDC), { lots: 2n, level: 6 });
  assert.match(
    bidPlan(round(), "2", "0.9", USDC).problem,
    /Bid at least 1 USDC a lot/,
  );
  assert.match(
    bidPlan(round(), "2", "1.0000001", USDC).problem,
    /decimal places/,
  );
  // The same typed text means the token's own units: "1" is one whole FQ, which is step 0 of this grid, and the form
  // takes as many decimals as the token has.
  assert.deepEqual(sellPlan(wideRound(), "2", "1", FQ), { lots: 2n, level: 0 });
  assert.deepEqual(sellPlan(wideRound(), "2", "65", FQ), {
    lots: 2n,
    level: 64,
  });
  assert.deepEqual(sellPlan(wideRound(), "2", "1.000000000000000001", FQ), {
    lots: 2n,
    level: 1,
  });
  assert.match(
    bidPlan(wideRound(), "2", "0.5", FQ).problem,
    /Bid at least 1 FQ a lot/,
  );
  // A seventh decimal is refused on a six-decimal token; a nineteenth on an eighteen-decimal one.
  assert.match(
    sellPlan(wideRound(), "1", "1.0000000000000000001", FQ).problem,
    /at most 18 decimal places/,
  );
});

test("an order's escrow is whole lots at its step's price", () => {
  assert.equal(sellHolds(3n, LOT), 300n * E18);
  assert.equal(bidHolds(round(), 5n, 4), 5n * 1_032_000n);
  assert.equal(bidHolds(wideRound(), 2n, 64), 130n * E18);
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
    sellOrderLine(round(), sell({ lots: 2n, minStep: 1, filled: 1n }), USDC),
    "You offer 2 lots at 1.008 USDC a lot or more.",
  );
  assert.equal(
    sellOrderLine(
      round({ phase: "settled" }),
      sell({ lots: 2n, minStep: 1, filled: 1n }),
      USDC,
    ),
    "You offer 2 lots at 1.008 USDC a lot or more. Sold: 1 lot at the round's price.",
  );
  // An order that filled nothing, in a settled round, never claims a price it did not trade at.
  const none = sellOrderLine(
    round({ phase: "settled" }),
    sell({ lots: 2n, minStep: 5, filled: 0n }),
    USDC,
  );
  assert.equal(
    none,
    "You offer 2 lots at 1.04 USDC a lot or more. Nothing sold: your Shares are back with you.",
  );
  assert.doesNotMatch(none, /round's price/);
  const noneBid = bidOrderLine(
    round({ phase: "settled" }),
    bid({ lots: 2n, maxStep: 2, filled: 0n }),
    USDC,
  );
  assert.equal(
    noneBid,
    "You bid for 2 lots at up to 1.016 USDC a lot. Nothing bought: your money is yours to collect.",
  );
  assert.doesNotMatch(noneBid, /round's price/);
  assert.match(
    bidOrderLine(round(), bid({ cancelled: true }), USDC),
    /money is yours to collect/,
  );
  assert.equal(
    bidOrderLine(round(), bid({ lots: 2n, maxStep: 1 }), USDC),
    "You bid for 2 lots at up to 1.008 USDC a lot.",
  );
});

test("the card re-reads on its own only while a round ends by the clock", () => {
  // Taking orders and waiting to settle both end with no one acting, so the card keeps looking.
  for (const phase of ["bidding", "settling"]) {
    assert.equal(
      refreshEveryMs(market({ round: round({ phase }) })),
      LIVE_REFRESH_MS,
      phase,
    );
  }
  // A finished round, no round, and every read that did not complete change only when someone acts.
  for (const phase of ["settled", "void"]) {
    assert.equal(
      refreshEveryMs(market({ round: round({ phase }) })),
      false,
      phase,
    );
  }
  assert.equal(refreshEveryMs(market()), false);
  assert.equal(refreshEveryMs(undefined), false);
  assert.equal(refreshEveryMs({ kind: "absent" }), false);
  assert.equal(refreshEveryMs({ kind: "unreadable", reason: "x" }), false);
  assert.ok(LIVE_REFRESH_MS >= 10_000, "never a tight loop on the node");
});

test("a wallet with an order in a round waiting to settle is told who can settle it and by when", () => {
  const waiting = round({ phase: "settling" });
  const withSell = { sell: sell(), bid: null };
  const notice = settleNoticeLine(waiting, withSell);
  assert.match(notice, /Anyone can settle it/);
  assert.match(notice, /only a network fee/);
  assert.match(notice, /by Oct 19/);
  assert.match(notice, /the round is void and you take back what you put in/);
  assert.equal(
    settleNoticeLine(waiting, { sell: null, bid: bid() }),
    notice,
    "a bid waits the same way",
  );
  // A bid already taken back has nothing left in the round to wait for.
  assert.equal(
    settleNoticeLine(waiting, { sell: null, bid: bid({ cancelled: true }) }),
    null,
  );
  // Someone with no order is not told about an order.
  assert.equal(settleNoticeLine(waiting, { sell: null, bid: null }), null);
  // Only a round waiting to settle has the notice: bidding has its own sentence, a finished one pays out.
  for (const phase of ["bidding", "settled", "void", "none"]) {
    assert.equal(settleNoticeLine(round({ phase }), withSell), null, phase);
  }
});

// ---- earlier rounds ----------------------------------------------------------------------------------------------

const earlier = (id, phase, orders, over = {}) => ({
  id,
  round: round({ phase, settled: phase === "settled", ...over }),
  sell: orders.sell ?? null,
  bid: orders.bid ?? null,
});

test("each earlier round owes by its own result, so an older round is not lost behind a newer one", () => {
  const owed = earlierDues(
    [
      // Newest first: a void round owes both sides everything it took in.
      earlier(3n, "void", {
        sell: sell({ lots: 3n }),
        bid: bid({ lots: 2n, maxStep: 1 }),
      }),
      // A settled one owes the buyer's Shares and refund at its own price.
      earlier(
        2n,
        "settled",
        { bid: bid({ lots: 5n, maxStep: 4, filled: 3n }) },
        { price: 2 },
      ),
      // Everything here was already collected.
      earlier(
        1n,
        "settled",
        {
          sell: sell({ filled: 2n, proceedsPaid: true }),
          bid: bid({ filled: 3n, sharesPaid: true, refundDone: true }),
        },
        { price: 2 },
      ),
    ],
    LOT,
  );
  assert.deepEqual(
    owed.map((o) => [o.earlier.id, o.due]),
    [
      [3n, { shares: 3n * LOT, quote: 2n * 1_008_000n }],
      [2n, { shares: 3n * LOT, quote: 5n * 1_032_000n - 3n * 1_016_000n }],
    ],
  );
  assert.deepEqual(earlierDues([], LOT), []);
});

test("an earlier round says what became of it, and the look-back limit is said out loud", () => {
  assert.match(
    earlierRoundLine(round({ phase: "void" })),
    /was never settled, so what you put into it is yours to take back/,
  );
  assert.match(
    earlierRoundLine(round({ phase: "settled" })),
    /has settled, and you still have something to collect/,
  );
  assert.equal(earlierLimitLine(8, 0n), null);
  assert.equal(
    earlierLimitLine(8, 3n),
    "This page checks your last 8 rounds. Anything an older round owes you is still yours, but it can't be collected from here.",
  );
});
