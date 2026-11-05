import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  bidHolds,
  bidOrderLine,
  bidPlan,
  cardMode,
  claimDue,
  collectQuoteLabel,
  earlierDues,
  earlierAllCheckedLine,
  earlierLimitLine,
  checkOlderLabel,
  olderFailedLine,
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
  quoteHeldLine,
  refreshEveryMs,
  roundLine,
  roundTerms,
  shownTerms,
  sellHolds,
  sellOrderLine,
  sellPlan,
  sellRoomLine,
  settleNoticeLine,
  SLOW_REFRESH_MS,
  staleReadLine,
  stepAtLeast,
  stepAtMost,
  tokenUnreadableLine,
  tradingFailureLine,
  tradingStateLine,
  UNKNOWN_QUOTE,
  unreadableLine,
} from "./trading-copy.ts";
import * as copy from "./trading-copy.ts";

// The disclosure and failure helpers, read off the module so one missing export fails its own test.
const {
  bidPlanLine,
  failureStands,
  LISTING_OFF_HINT,
  MARKET_REVIEWED,
  sellPlanLine,
  tradingFailure,
  tradingLimits,
  unreviewedLine,
} = copy;

/** A sibling file's source, for the wiring a node test cannot mount. */
const read = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

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

/**
 * What a wallet holds in a market that trades in `LOT`-sized lots: plenty of everything, so a test says what it limits.
 * Quantities are base units: Shares at the lot's own scale, quote at the token's.
 */
const funds = (over = {}) => ({
  saleCapacity: 1_000n * LOT,
  shares: 1_000n * LOT,
  quote: 1_000_000n * USD,
  quoteAllowance: 0n,
  ...over,
});
/** The market's own units for a seller's form: the quote token's and the lot's size. */
const SELL_USDC = { ...USDC, lotSize: LOT };
const SELL_FQ = { ...FQ, lotSize: LOT };

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
  assert.equal(copy.sharesPhrase(LOT), "100 Shares");
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
    "A lot is 1 Share. Each step is 1 FQ apart.",
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
  assert.deepEqual(sellPlan(round(), "2", "1.008", SELL_USDC, funds()), {
    lots: 2n,
    level: 1,
  });
  assert.match(
    sellPlan(round(), "0", "1", SELL_USDC, funds()).problem,
    /at least one whole lot/,
  );
  assert.match(
    sellPlan(round(), "1.5", "1", SELL_USDC, funds()).problem,
    /whole number of lots/,
  );
  assert.match(
    sellPlan(round(), "1", "1.1", SELL_USDC, funds()).problem,
    /above this round's highest/,
  );
  assert.deepEqual(bidPlan(round(), "2", "1.05", USDC, funds()), {
    lots: 2n,
    level: 6,
  });
  assert.match(
    bidPlan(round(), "2", "0.9", USDC, funds()).problem,
    /Bid at least 1 USDC a lot/,
  );
  assert.match(
    bidPlan(round(), "2", "1.0000001", USDC, funds()).problem,
    /decimal places/,
  );
  // The same typed text means the token's own units: "1" is one whole FQ, which is step 0 of this grid, and the form
  // takes as many decimals as the token has.
  assert.deepEqual(sellPlan(wideRound(), "2", "1", SELL_FQ, funds()), {
    lots: 2n,
    level: 0,
  });
  assert.deepEqual(sellPlan(wideRound(), "2", "65", SELL_FQ, funds()), {
    lots: 2n,
    level: 64,
  });
  assert.deepEqual(
    sellPlan(wideRound(), "2", "1.000000000000000001", SELL_FQ, funds()),
    {
      lots: 2n,
      level: 1,
    },
  );
  assert.match(
    bidPlan(wideRound(), "2", "0.5", FQ, funds()).problem,
    /Bid at least 1 FQ a lot/,
  );
  // A seventh decimal is refused on a six-decimal token; a nineteenth on an eighteen-decimal one.
  assert.match(
    sellPlan(wideRound(), "1", "1.0000000000000000001", SELL_FQ, funds())
      .problem,
    /at most 18 decimal places/,
  );
});

test("a price typed with a decimal comma means the same as with a point, and a malformed one is not called a decimal-places problem", () => {
  const sell = (text) => sellPlan(round(), "2", text, SELL_USDC, funds());
  const bid = (text) => bidPlan(round(), "2", text, USDC, funds());
  // Many keyboards show a comma for inputMode decimal: "1,05" is 1.05, not a rejected number.
  assert.deepEqual(bid("1,05"), bid("1.05"));
  assert.deepEqual(bid("1,05"), { lots: 2n, level: 6 });
  assert.deepEqual(sell("1,02"), sell("1.02"));
  assert.equal("problem" in sell("1,02"), false);
  // "1," and "1." and ".5" are not finished prices: the message says how to write one, not that there are too many decimals.
  for (const text of ["1.", "1,", ".5", ",5", "1.2.3", "abc"]) {
    for (const plan of [sell(text), bid(text)]) {
      assert.match(plan.problem, /a number like 1\.05/, text);
      assert.doesNotMatch(plan.problem, /decimal places/, text);
    }
  }
  // Too many decimals still says so, with a comma too.
  assert.match(bid("1,0000001").problem, /at most 6 decimal places/);
  assert.match(bid("1.0000001").problem, /at most 6 decimal places/);
  // "1,000" could be one thousand or one: guessing is a 1000x mistake in someone's money, so it is refused in words.
  for (const text of ["1,000", "1,008", "1,000.50", "12,345,678"]) {
    assert.match(bid(text).problem, /with a point and no commas/, text);
    assert.match(sell(text).problem, /with a point and no commas/, text);
  }
});

test("an oversized number of lots is refused in words, never planned (the contract's own cap)", () => {
  const huge = "99999999999999999999999999999";
  const cap = (1n << 96n).toString();
  const overCap = ((1n << 96n) + 1n).toString();
  const rich = funds({
    saleCapacity: 1n << 200n,
    shares: 1n << 200n,
    quote: 1n << 200n,
  });
  for (const text of [huge, overCap]) {
    assert.match(
      sellPlan(round(), text, "1", SELL_USDC, rich).problem,
      /more lots than one order can hold/,
    );
    assert.match(
      bidPlan(round(), text, "1.05", USDC, rich).problem,
      /more lots than one order can hold/,
    );
  }
  // The cap itself is a whole order, as the contract takes it.
  assert.deepEqual(sellPlan(round(), cap, "1", SELL_USDC, rich), {
    lots: 1n << 96n,
    level: 0,
  });
});

test("an order whose total does not fit a 256-bit amount is refused in words", () => {
  const cap = (1n << 96n).toString();
  const rich = funds({
    saleCapacity: 1n << 255n,
    shares: 1n << 255n,
    quote: 1n << 255n,
  });
  // 2^96 lots of 2^200 Shares is 2^296: no balance holds that, and no call could carry it.
  assert.match(
    sellPlan(round(), cap, "1", { ...USDC, lotSize: 1n << 200n }, rich).problem,
    /more Shares than/,
  );
  const dear = round({ minPrice: 1n, step: 1n << 200n, levels: 8 });
  assert.match(
    bidPlan(dear, cap, "1".padEnd(62, "0"), USDC, rich).problem,
    /more money than/,
  );
});

test("an offer is held to what the wallet can offer now, and says why", () => {
  // Nothing unlocked yet (a founder's schedule at birth): the plan is a problem, with the reason.
  const locked = sellPlan(
    round(),
    "1",
    "1",
    SELL_USDC,
    funds({ saleCapacity: 0n }),
  );
  assert.match(locked.problem, /sale schedule/);
  assert.doesNotMatch(locked.problem, /unlock|unvested|Try again later/i);
  assert.doesNotMatch(locked.problem, /NoCapacity|revert|capacity/i);
  // Part unlocked: the most it can offer is the whole lots inside it.
  const part = sellPlan(
    round(),
    "4",
    "1",
    SELL_USDC,
    funds({ saleCapacity: 3n * LOT + 5n, shares: 10n * LOT }),
  );
  assert.match(part.problem, /up to 3 lots now/);
  assert.match(part.problem, /not yet released for sale .* sale schedule/);
  assert.doesNotMatch(part.problem, /unlock|unvested/i);
  assert.deepEqual(
    sellPlan(
      round(),
      "3",
      "1",
      SELL_USDC,
      funds({ saleCapacity: 3n * LOT + 5n, shares: 10n * LOT }),
    ),
    { lots: 3n, level: 0 },
  );
  // Shares it does not hold cannot be offered however much is unlocked.
  assert.match(
    sellPlan(
      round(),
      "2",
      "1",
      SELL_USDC,
      funds({ saleCapacity: 9n * LOT, shares: LOT }),
    ).problem,
    /up to 1 lot now/,
  );
  assert.match(
    sellPlan(
      round(),
      "1",
      "1",
      SELL_USDC,
      funds({ saleCapacity: 9n * LOT, shares: LOT - 1n }),
    ).problem,
    /less than one whole lot/,
  );
});

test("the offer form's room line says how much can be offered now", () => {
  assert.equal(
    sellRoomLine(funds({ saleCapacity: 3n * LOT, shares: 3n * LOT }), LOT),
    "You can offer up to 3 lots now (300 Shares).",
  );
  assert.match(
    sellRoomLine(funds({ saleCapacity: 0n, shares: 3n * LOT }), LOT),
    /None of your Shares .* released for sale yet .* sale schedule.*become offerable as the schedule runs/,
  );
  assert.doesNotMatch(
    sellRoomLine(funds({ saleCapacity: 0n, shares: 3n * LOT }), LOT),
    /Try again later|unlock/i,
  );
  assert.match(
    sellRoomLine(funds({ saleCapacity: 0n, shares: 0n }), LOT),
    /hold no Shares/,
  );
  assert.match(
    sellRoomLine(funds({ saleCapacity: 2n * LOT, shares: 5n * LOT }), LOT),
    /up to 2 lots now.*not yet released for sale .* sale schedule/,
  );
});

test("a bid is held to the money the wallet holds", () => {
  // Two lots at step 6 (1.048 USDC) hold 2.096 USDC.
  const broke = bidPlan(round(), "2", "1.05", USDC, funds({ quote: USD }));
  assert.match(broke.problem, /hold 1 USDC/);
  assert.match(broke.problem, /2\.096 USDC/);
  assert.equal(
    quoteHeldLine(funds({ quote: 2_096_000n }), USDC),
    "You hold 2.096 USDC.",
  );
  assert.deepEqual(
    bidPlan(round(), "2", "1.05", USDC, funds({ quote: 2_096_000n })),
    { lots: 2n, level: 6 },
  );
});

test("a failed order is said in plain words, whichever way the network spells the refusal", () => {
  // Every refusal the market can give a person, each with a next step and none with its code in the main words.
  for (const [name, words] of [
    ["NoCapacity", /sale schedule/],
    ["DaoCannotSell", /project's own Shares/],
    ["BadAmount", /didn't match/],
    ["TooManySellers", /as many offers as/],
    ["TooManyBuyers", /as many bids as/],
    ["OneOrderPerSide", /already have an order/],
    ["BiddingOver", /have closed/],
    ["ListingNotEnabled", /turned off.*still pay out/],
    ["TooSoon", /can't open yet.*a week apart/],
    ["UnknownRound", /wasn't found.*Refresh/],
    ["BiddingOpen", /still open.*Try again when bidding has closed/],
    ["SettleOver", /time to settle.*passed.*takes back/],
    [
      "AlreadySettled",
      /^Someone settled this round just before you\. Refreshing now\.$/,
    ],
    ["BadLots", /whole number of lots/],
    ["BadStep", /range/],
    ["NoOrder", /no order/],
    ["NothingToClaim", /nothing left to collect/],
    ["LedgerShort", /nothing changed.*Refresh and try again/],
  ]) {
    for (const spelling of [
      `execution reverted: ${name}()`,
      `execution reverted: ${name}(7)`,
      `The contract function "sell" reverted with the following reason: ${name}()`,
      `reverted with custom error '${name}()'`,
    ]) {
      const failure = tradingFailure(spelling);
      assert.match(failure.text, words, spelling);
      assert.doesNotMatch(failure.text, new RegExp(name), spelling);
      assert.equal(failure.detail, spelling, "the raw words are kept apart");
      assert.equal(tradingFailureLine(spelling), failure.text);
    }
  }
  // A sentence the app already wrote for people (the passkey path's) is kept, with nothing to hide.
  assert.deepEqual(tradingFailure("Part of this went through"), {
    text: "That step was refused, so nothing changed. Refresh and try again.",
    detail: "Part of this went through",
  });
  const written =
    "You closed the passkey prompt, or it timed out, so nothing was sent. Press the button again and confirm with your passkey.";
  assert.deepEqual(tradingFailure(written), { text: written, detail: null });
});

test("a raw wallet or network error never reaches the main words", () => {
  for (const raw of [
    "HTTP request failed.\n\nStatus: 429\nURL: https://rpc.example/key\nDetails: Too Many Requests",
    "execution reverted: 0x4e487b71",
    "Internal JSON-RPC error.",
    'The contract function "settle" reverted.\n\nContract Call:\n  address: 0xabc',
    "Failed to fetch",
    "",
  ]) {
    const failure = tradingFailure(raw);
    assert.equal(
      failure.text,
      "That step was refused, so nothing changed. Refresh and try again.",
      raw,
    );
    assert.equal(failure.detail, raw === "" ? null : raw);
    assert.doesNotMatch(failure.text, /HTTP|429|revert|0x|RPC/);
  }
});

test("a failure note survives a poll that changes nothing, and goes when the round or phase moves on", () => {
  const raised = { failure: "x", round: "3:bidding" };
  // A successful re-read of the same round and phase (the card polls every 30 s) advances the read time but is not a
  // reason to drop a note about a dismissed prompt or a refused wallet. Extra read-time fields must not matter.
  for (const readAt of [100, 101, 130_000]) {
    assert.equal(failureStands(raised, { readAt, round: "3:bidding" }), true);
  }
  // A round that moved to its next phase, or a new round, makes the note stale.
  assert.equal(failureStands(raised, { round: "3:settling" }), false);
  assert.equal(failureStands(raised, { round: "4:bidding" }), false);
  assert.equal(failureStands(raised, { round: "none" }), false);
});

test("the card keeps the failure note across polls: its clearing rule never reads the poll time", () => {
  const card = read("../ui/TradingCard.tsx");
  const start = card.indexOf("const failureMark = useRef");
  const end = card.indexOf("return (", start);
  assert.ok(start > 0 && end > start);
  const effect = card.slice(start, end);
  assert.match(effect, /failureStands\(/);
  assert.doesNotMatch(effect, /dataUpdatedAt|readAt/);
  // The next user action clears it: every new send attempt starts by dropping the old note.
  const send = read("../use-chain-send.ts");
  assert.match(send, /setBusy\(key\);\s*setFailure\(null\);/);
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
    "You offer 2 lots at 1.008 USDC a lot or more. Sold: 1 lot at the round's price. 1 lot to take back.",
  );
  // An order that filled nothing, in a settled round, never claims a price it did not trade at.
  const none = sellOrderLine(
    round({ phase: "settled" }),
    sell({ lots: 2n, minStep: 5, filled: 0n }),
    USDC,
  );
  assert.equal(
    none,
    "You offer 2 lots at 1.04 USDC a lot or more. Nothing sold: your Shares are yours to take back.",
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

test("the card re-reads on its own while a round ends by the clock", () => {
  // Taking orders and waiting to settle both end with no one acting, so the card keeps looking.
  for (const phase of ["bidding", "settling"]) {
    assert.equal(
      refreshEveryMs(market({ round: round({ phase }) })),
      LIVE_REFRESH_MS,
      phase,
    );
  }
  assert.ok(LIVE_REFRESH_MS >= 10_000, "never a tight loop on the node");
});

test("a finished round keeps the card looking, so a tab left open sees the next round", () => {
  const next = OCT_14 + 7 * 86_400;
  for (const phase of ["settled", "void"]) {
    const read = market({ round: round({ phase }) });
    // Waiting for the next round to be allowed: look again when it is, not a week later.
    assert.equal(refreshEveryMs(read, next - 120), 120_000, phase);
    assert.equal(refreshEveryMs(read, next - 5), 5_000, phase);
    // Never a tight loop, and never longer than the slow poll.
    assert.equal(refreshEveryMs(read, next - 1), 1_000, phase);
    assert.equal(refreshEveryMs(read, next), SLOW_REFRESH_MS, phase);
    assert.equal(
      refreshEveryMs(read, next - 3 * 86_400),
      SLOW_REFRESH_MS,
      phase,
    );
    // Allowed already (the open button shows) or someone else opened it: the slow poll finds out.
    assert.equal(refreshEveryMs(read, next + 10), SLOW_REFRESH_MS, phase);
  }
  // A closed listing may be published again, and a market with no round may have one opened by someone else.
  const off = market({ round: round({ phase: "settled" }) });
  off.listing = { ...off.listing, enabled: false };
  assert.equal(refreshEveryMs(off, OCT_14), SLOW_REFRESH_MS);
  assert.equal(refreshEveryMs(market()), SLOW_REFRESH_MS);
});

test("a read with no market and no answer has nothing to look at again", () => {
  assert.equal(refreshEveryMs(undefined), false);
  assert.equal(refreshEveryMs({ kind: "absent" }), false);
  assert.equal(refreshEveryMs({ kind: "unreadable", reason: "x" }), false);
});

test("after failed reads the card keeps looking, slower each time, up to a cap", () => {
  const live = market({ round: round({ phase: "bidding" }) });
  const waits = [1, 2, 3, 4, 5, 20].map((n) => refreshEveryMs(live, 0, n));
  assert.deepEqual(
    waits,
    [60_000, 120_000, 240_000, 300_000, 300_000, 300_000],
  );
  // Failing with nothing read yet is still looked at again; only a market we know is absent is left alone.
  assert.equal(refreshEveryMs(undefined, 0, 1), 60_000);
  assert.equal(refreshEveryMs({ kind: "absent" }, 0, 1), 60_000);
  assert.ok(refreshEveryMs(live, 0, 1) >= LIVE_REFRESH_MS);
});

test("the card keeps what it last read on screen when a refresh fails, and says so", () => {
  const view = { read: market() };
  // Nothing ever read: the unreadable block, with its retry.
  assert.equal(
    cardMode({ factoryKnown: true, data: undefined, failed: true }),
    "unreadable",
  );
  assert.equal(
    cardMode({ factoryKnown: true, data: undefined, failed: false }),
    "reading",
  );
  assert.equal(
    cardMode({ factoryKnown: false, data: view, failed: true }),
    "missing",
  );
  // Something read earlier: the card, failed refresh or not.
  assert.equal(
    cardMode({ factoryKnown: true, data: view, failed: false }),
    "ready",
  );
  assert.equal(
    cardMode({ factoryKnown: true, data: view, failed: true }),
    "ready",
  );
  // A view that is itself an unreadable answer is not something to keep on screen.
  assert.equal(
    cardMode({
      factoryKnown: true,
      data: { read: { kind: "unreadable", reason: "x" } },
      failed: false,
    }),
    "unreadable",
  );
});

test("the refresh note says when what is shown was read, in plain words", () => {
  const line = staleReadLine(Date.UTC(2026, 9, 14, 15, 7), "UTC");
  assert.equal(
    line,
    "Could not refresh just now. What is shown was read at 3:07 PM.",
  );
  assert.doesNotMatch(line, /relay|nsec|rpc|revert|0x/i);
});

test("a collect button names the money in the token's units, or just says so when the token will not say them", () => {
  assert.equal(
    collectQuoteLabel(1_500_000n, { ...USDC, quoteKnown: true }),
    "Collect 1.5 USDC",
  );
  assert.equal(collectQuoteLabel(1_500_000n, USDC), "Collect 1.5 USDC");
  assert.equal(
    collectQuoteLabel(1_500_000n, { ...UNKNOWN_QUOTE, quoteKnown: false }),
    "Collect your money",
  );
});

test("amounts the token will not give units for are written as base units, never a guessed currency", () => {
  assert.equal(money(1_500_000n, UNKNOWN_QUOTE), "1,500,000 base units");
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
    "This page has checked your last 8 rounds. Rounds 1 to 3 are not checked yet. Anything an older round owes you is still yours.",
  );
  assert.equal(
    earlierLimitLine(8, 1n),
    "This page has checked your last 8 rounds. Round 1 is not checked yet. Anything an older round owes you is still yours.",
  );
  // Once more is checked the line counts them all, and the button's own words say what it does.
  assert.match(earlierLimitLine(16, 2n), /last 16 rounds/);
  assert.equal(checkOlderLabel(false), "Check older rounds");
  assert.equal(checkOlderLabel(true), "Checking…");
  assert.equal(
    earlierAllCheckedLine(false),
    "Every round has been checked. Nothing older is waiting for you.",
  );
  assert.match(olderFailedLine(), /could not check/i);
  for (const line of [
    earlierLimitLine(8, 3n),
    olderFailedLine(),
    earlierAllCheckedLine(false),
    earlierAllCheckedLine(true),
  ]) {
    assert.doesNotMatch(line, /relay|nsec|rpc|revert|0x|cast/i);
  }
});

test("the all-checked line never says nothing is waiting while a Collect row is shown", () => {
  // Every round checked AND an earlier round still owes the wallet: the line must not contradict the Collect row.
  const owedLine = earlierAllCheckedLine(true);
  assert.equal(owedLine, "Every round has been checked.");
  assert.doesNotMatch(owedLine, /nothing|waiting/i);
  // Nothing owed: the reassurance is allowed, and only then.
  assert.match(
    earlierAllCheckedLine(false),
    /Nothing older is waiting for you/,
  );
  // The card picks the line from what is owed, through the production function.
  const earlier = read("../ui/TradingEarlier.tsx");
  assert.match(earlier, /earlierAllCheckedLine\(owed\.length > 0\)/);
  assert.doesNotMatch(earlier, /earlierAllCheckedLine\(\)/);
});

test("a part-filled seller in a settled round is owed its unsold lots as Shares, and stops being owed once they are collected", () => {
  const settled = round({ phase: "settled", settled: true, price: 2 });
  // 5 offered, 2 sold: 3 lots of Shares wait in the market besides the proceeds.
  assert.deepEqual(
    claimDue(settled, { sell: sell({ lots: 5n, filled: 2n }), bid: null }, LOT),
    { shares: 3n * LOT, quote: 2n * 1_016_000n },
  );
  // Nothing sold: all of it waits, and there is no money.
  assert.deepEqual(
    claimDue(settled, { sell: sell({ lots: 5n }), bid: null }, LOT),
    { shares: 5n * LOT, quote: 0n },
  );
  // Sold out whole: no Shares to take back.
  assert.deepEqual(
    claimDue(settled, { sell: sell({ lots: 5n, filled: 5n }), bid: null }, LOT),
    { shares: 0n, quote: 5n * 1_016_000n },
  );
  // The remainder collected (escrowReturned) stops showing, while the proceeds still do.
  assert.deepEqual(
    claimDue(
      settled,
      { sell: sell({ lots: 5n, filled: 2n, escrowReturned: true }), bid: null },
      LOT,
    ),
    { shares: 0n, quote: 2n * 1_016_000n },
  );
  // Both collected: nothing at all.
  assert.deepEqual(
    claimDue(
      settled,
      {
        sell: sell({
          lots: 5n,
          filled: 2n,
          escrowReturned: true,
          proceedsPaid: true,
        }),
        bid: null,
      },
      LOT,
    ),
    { shares: 0n, quote: 0n },
  );
  // A wallet that sold and bought in one round is owed both kinds of Shares in one claim.
  assert.deepEqual(
    claimDue(
      settled,
      {
        sell: sell({ lots: 5n, filled: 2n, proceedsPaid: true }),
        bid: bid({ lots: 1n, maxStep: 2, filled: 1n, refundDone: true }),
      },
      LOT,
    ),
    { shares: 4n * LOT, quote: 0n },
  );
});

test("a collected void offer stops being owed, and a round still open owes no remainder", () => {
  assert.deepEqual(
    claimDue(
      round({ phase: "void" }),
      { sell: sell({ lots: 3n, escrowReturned: true }), bid: null },
      LOT,
    ),
    { shares: 0n, quote: 0n },
  );
  assert.deepEqual(
    claimDue(
      round({ phase: "settling" }),
      { sell: sell({ lots: 3n }), bid: null },
      LOT,
    ),
    { shares: 0n, quote: 0n },
  );
});

test("a seller's line says what sold and what is left to take back, then that it is back", () => {
  const settled = round({ phase: "settled" });
  const part = sell({ lots: 5n, minStep: 1, filled: 2n });
  assert.equal(
    sellOrderLine(settled, part, USDC),
    "You offer 5 lots at 1.008 USDC a lot or more. Sold: 2 lots at the round's price. 3 lots to take back.",
  );
  assert.equal(
    sellOrderLine(settled, { ...part, escrowReturned: true }, USDC),
    "You offer 5 lots at 1.008 USDC a lot or more. Sold: 2 lots at the round's price. The other 3 lots are back with you.",
  );
  assert.equal(
    sellOrderLine(settled, { ...part, filled: 4n, escrowReturned: true }, USDC),
    "You offer 5 lots at 1.008 USDC a lot or more. Sold: 4 lots at the round's price. The other lot is back with you.",
  );
  // Sold out whole says only what sold.
  assert.equal(
    sellOrderLine(settled, { ...part, filled: 5n }, USDC),
    "You offer 5 lots at 1.008 USDC a lot or more. Sold: 5 lots at the round's price.",
  );
  assert.equal(
    sellOrderLine(
      settled,
      sell({ lots: 2n, minStep: 5, escrowReturned: true }),
      USDC,
    ),
    "You offer 2 lots at 1.04 USDC a lot or more. Nothing sold: your Shares are back with you.",
  );
  assert.equal(
    sellOrderLine(round({ phase: "void" }), sell({ lots: 2n }), USDC),
    "You offer 2 lots at 1 USDC a lot or more. The round went void, so they are yours to take back.",
  );
  assert.equal(
    sellOrderLine(
      round({ phase: "void" }),
      sell({ lots: 2n, escrowReturned: true }),
      USDC,
    ),
    "You offer 2 lots at 1 USDC a lot or more. The round went void, so they are back with you.",
  );
});

test("an earlier settled round still owes a part-filled seller its remainder, until it is collected", () => {
  const rounds = [
    earlier(
      3n,
      "settled",
      { sell: sell({ lots: 5n, filled: 2n, proceedsPaid: true }) },
      { price: 2 },
    ),
    earlier(
      2n,
      "settled",
      {
        sell: sell({
          lots: 5n,
          filled: 2n,
          proceedsPaid: true,
          escrowReturned: true,
        }),
      },
      { price: 2 },
    ),
  ];
  assert.deepEqual(
    earlierDues(rounds, LOT).map((o) => [o.earlier.id, o.due]),
    [[3n, { shares: 3n * LOT, quote: 0n }]],
  );
});

// ---- disclosures ---------------------------------------------------------------------------------------------------

test("the limits of weekly trading are said in plain words, each once", () => {
  const limits = tradingLimits();
  const text = limits.join(" ");
  assert.match(
    text,
    /Shares held in a round don't vote and don't earn payouts/,
  );
  assert.match(text, /vote .* about a week \(7 to 8 days\) after you collect/);
  assert.match(text, /only way to sell Shares here/);
  assert.match(text, /filled in part, or not at all/);
  assert.match(text, /What isn't filled waits for you to collect it/);
  assert.doesNotMatch(text, /comes? back to you/);
  assert.match(text, /not .* outside security or legal review/);
  assert.equal(limits.length, 5);
  assert.equal(new Set(limits).size, 5);
  // Plain words: no contract names, no event numbers, no citations.
  assert.doesNotMatch(
    text,
    /pro rata|escrow|Payouts\.sol|kind \d|NIP|ActivationVoting/i,
  );
});

test("the vote delay wording comes from one constant, pinned to the voting contract", () => {
  const src = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../contracts/src/ActivationVoting.sol",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const epochs = /uint256 public constant MATURITY_EPOCHS = (\d+);/.exec(src);
  const epoch = /uint64 public constant EPOCH = 1 days;/.exec(src);
  assert.ok(epochs, "MATURITY_EPOCHS not found in ActivationVoting.sol");
  assert.ok(epoch, "EPOCH is no longer one day in ActivationVoting.sol");
  assert.equal(copy.VOTE_MATURITY_EPOCHS, Number(epochs[1]));
  const n = copy.VOTE_MATURITY_EPOCHS;
  assert.equal(copy.voteDelayDays(), `${n - 1} to ${n} days`);
  assert.ok(tradingLimits().some((l) => l.includes(`(${n - 1} to ${n} days)`)));
});

test("the review notice is tied to one release switch, which is off", () => {
  assert.equal(MARKET_REVIEWED, false);
  assert.match(unreviewedLine(), /not been independently reviewed/);
  assert.match(unreviewedLine(), /Do not trade with money you cannot lose/);
  assert.equal(unreviewedLine(true), null);
});

test("the offer and bid previews say what holding and filling mean at the moment of acting", () => {
  const plan = { lots: 3n, level: 6 };
  const sellLine = sellPlanLine(round(), plan, SELL_USDC);
  assert.match(
    sellLine,
    /This holds 3 lots \(300 Shares\) until the round settles/,
  );
  assert.match(sellLine, /don't vote and don't earn payouts/);
  assert.match(sellLine, /filled in part, or not at all/);
  assert.match(sellLine, /What isn't filled waits for you to collect it/);
  assert.match(sellLine, /1\.048 USDC a lot at step 6/);
  const bidLine = bidPlanLine(round(), plan, USDC);
  assert.match(bidLine, /This bid holds 3\.144 USDC until the round settles/);
  assert.match(bidLine, /never more than yours, and get back the rest/);
  assert.match(bidLine, /filled in part, or not at all/);
  assert.match(bidLine, /What isn't filled waits for you to collect it/);
  assert.match(bidLine, /about a week \(7 to 8 days\) after you collect them/);
});

test("the card and the forms say these limits where the person acts", () => {
  const forms = read("../ui/TradingOrderForms.tsx");
  assert.match(forms, /sellPlanLine\(/);
  assert.match(forms, /bidPlanLine\(/);
  const card = read("../ui/TradingCard.tsx");
  assert.match(card, /tradingLimits\(\)/);
  // The how-it-works text must not promise that unsold Shares return by themselves.
  assert.doesNotMatch(card, /Unsold Shares come\s+back to their seller/);
  assert.match(card, /Unsold Shares wait\s+for their\s+seller to collect them/);
  const listing = read("../ui/TradingListingForm.tsx");
  assert.match(listing, /unreviewedLine\(\)/);
  assert.match(listing, /\{unreviewed\}/);
  assert.match(listing, /data-testid="listing-unreviewed"/);
});

// ---- the off switch and raw reasons --------------------------------------------------------------------------------

test("turning the listing off is said as the contract does it: no new round, offer or bid", () => {
  assert.equal(
    LISTING_OFF_HINT,
    "No round opens and no new offer or bid is taken, until a later vote publishes terms again. Rounds already open or settled still settle, refund and pay out.",
  );
  const form = read("../ui/TradingListingForm.tsx");
  assert.match(form, /hint=\{LISTING_OFF_HINT\}/);
  assert.doesNotMatch(form, /Turning it off stops new rounds/);
  const composer = read("../ui/DecisionComposer.tsx");
  assert.doesNotMatch(composer, /Turning it off stops new rounds/);
  assert.match(
    composer,
    /Turning it off opens no round and takes no new offer or bid; settlement and claims carry on\./,
  );
});

test("a failed market read never puts the network's own words into the page", () => {
  const form = read("../ui/TradingListingForm.tsx");
  const draft = read("./listing-draft.ts");
  assert.doesNotMatch(form, /read\.reason/);
  assert.doesNotMatch(draft, /read\.reason/);
});

test("the card clears a failure note once its read or round has moved on, through the one rule", () => {
  const card = read("../ui/TradingCard.tsx");
  assert.match(card, /failureStands\(/);
  assert.match(card, /clearFailure\(\)/);
  assert.match(card, /tradingFailure\(sender\.failure\)/);
  const send = read("../use-chain-send.ts");
  assert.match(send, /clearFailure/);
});

// ---- the price token's identity (B7) ---------------------------------------------------------------------------------
//
// A founder picks the market's price token at launch and the token names itself, so a worthless token can call itself
// "USDC". The symbol alone proves nothing: the card, the listing form and the vote say which token it is, and say so
// plainly when it is not the project's sale currency.

const SALE_CURRENCY = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// Same first six and last four characters as the sale currency, a different token: a short form cannot tell them apart.
const LOOKALIKE = `0xa0b8${"0".repeat(32)}eb48`;

test("the price token is named by a short address next to its symbol", () => {
  assert.equal(copy.shortToken(SALE_CURRENCY), "0xa0b8…eb48");
  assert.equal(
    copy.quoteIdentityLine("USDC", SALE_CURRENCY),
    "Prices are in USDC, the token at 0xa0b8…eb48.",
  );
});

test("a price token that is the sale currency raises no warning, whatever the letter case of either address", () => {
  const same = copy.quoteIdentity(
    { symbol: "USDC", address: SALE_CURRENCY.toLowerCase() },
    SALE_CURRENCY.toUpperCase().replace("0X", "0x"),
  );
  assert.equal(same.differsFromSale, false);
  assert.equal(same.warning, null);
  assert.equal(
    copy.quoteDiffersFromSale(SALE_CURRENCY, SALE_CURRENCY.toLowerCase()),
    false,
  );
});

test("a price token that is not the sale currency says so plainly, even when its short address looks the same", () => {
  assert.equal(copy.shortToken(LOOKALIKE), copy.shortToken(SALE_CURRENCY));
  const other = copy.quoteIdentity(
    { symbol: "USDC", address: LOOKALIKE },
    SALE_CURRENCY,
  );
  assert.equal(other.differsFromSale, true);
  assert.match(
    other.warning,
    /priced in a token that is not this project's sale currency/,
  );
  assert.equal(other.address, LOOKALIKE, "the full address is kept to copy");
  assert.equal(copy.quoteDiffersFromSale(LOOKALIKE, SALE_CURRENCY), true);
});

test("with no recorded sale currency there is nothing to compare, and nothing is warned", () => {
  for (const none of [
    undefined,
    null,
    "",
    "   ",
    `0x${"0".repeat(40)}`,
    "usdc",
  ]) {
    assert.equal(
      copy.quoteDiffersFromSale(LOOKALIKE, none),
      false,
      String(none),
    );
  }
});

test("the identity and its warning are worded for people", () => {
  const { warning } = copy.quoteIdentity(
    { symbol: "USDC", address: LOOKALIKE },
    SALE_CURRENCY,
  );
  assert.doesNotMatch(warning, /\b(kind|NIP|nsec|relay|ERC)\b/i);
  assert.match(warning, /Check the token address before/);
});

test("the copy-address button's accessible name starts with its visible words (label in name)", () => {
  const note = read("../ui/QuoteTokenNote.tsx");
  const element = note.match(
    /<Button\b(?:(?!<Button)[\s\S])*?data-testid="quote-token-copy"[\s\S]*?<\/Button>/,
  );
  assert.ok(element, "the copy button is found");
  const text = element[0].match(/\n\s*>\s*([^<{]+?)\s*<\/Button>$/);
  assert.ok(text, "the copy button has plain visible text");
  const visible = text[1];
  assert.equal(visible, "Copy address");
  const label = element[0].match(/aria-label=\{`([^`]*)`\}/);
  assert.ok(label, "the copy button carries an aria-label");
  // WCAG 2.5.3: speech input says what it sees, so the visible words open the name and the token follows.
  assert.ok(
    label[1].startsWith(visible),
    `the name "${label[1]}" must start with "${visible}"`,
  );
  assert.match(label[1], /\$\{identity\.short\}/);
});

test("an order form's send button stays reachable while the plan is unfinished, so Enter can say what is missing", () => {
  const forms = read("../ui/TradingOrderForms.tsx");
  assert.doesNotMatch(forms, /disabled=\{blocked \|\| !ok\}/);
  assert.match(forms, /disabled=\{blocked\}/);
});

test("the card, the listing form and the vote all show the price token and its warning through the one rule", () => {
  const note = read("../ui/QuoteTokenNote.tsx");
  assert.match(note, /quoteIdentity\(/);
  assert.match(note, /navigator\.clipboard\.writeText\(/);
  assert.match(note, /aria-label=/);
  assert.match(note, /role="note"/);
  const card = read("../ui/TradingCard.tsx");
  assert.match(card, /<QuoteTokenNote/);
  assert.match(card, /saleCurrency=/);
  const form = read("../ui/TradingListingForm.tsx");
  assert.match(form, /<QuoteTokenNote/);
  assert.match(form, /saleCurrency/);
  const draft = read("./listing-draft.ts");
  assert.match(draft, /quoteToken/);
  assert.match(draft, /saleCurrency/);
  const page = read("../ui/LaunchDetailPage.tsx");
  assert.match(page, /saleCurrency=\{launch\.record\.currency/);
});

test("a live round states the terms it trades on, never the DAO's newer listing", () => {
  // The DAO changed its listing after the round opened: the round keeps the grid it copied (1 to 1.064, 8 steps).
  const changed = { ...listing, minPrice: 2n * USD, maxPrice: 4n * USD };
  assert.deepEqual(roundTerms(round()), {
    minPrice: USD,
    maxPrice: 1_064_000n,
    levels: 8,
  });
  for (const phase of ["bidding", "settling"]) {
    const read = market({ listing: changed, round: round({ phase }) });
    const line = tradingStateLine(read, OCT_17, USDC);
    assert.match(
      line,
      /this round trades from 1 USDC to 1\.064 USDC a lot/,
      phase,
    );
    // The listing's own terms are only the next round's.
    assert.match(line, /Next round: from 2 USDC to 4 USDC a lot/, phase);
    assert.doesNotMatch(line, /Trading is on: from 2 USDC/, phase);
    assert.deepEqual(
      shownTerms(changed, round({ phase })),
      roundTerms(round()),
    );
  }
  // The same terms say nothing extra, and a finished round shows the listing: it is what the next one will use.
  const same = tradingStateLine(market({ round: round() }), OCT_14, USDC);
  assert.doesNotMatch(same, /this round trades|Next round:/);
  const over = market({
    listing: changed,
    round: round({ phase: "settled", settled: true }),
  });
  assert.match(
    tradingStateLine(over, OCT_17, USDC),
    /^Trading is on: from 2 USDC to 4 USDC a lot/,
  );
  assert.equal(shownTerms(changed, round({ phase: "settled" })), changed);
  assert.equal(shownTerms(changed, null), changed);
});

test("a round still open under a listing the DAO switched off does not say orders are taken", () => {
  assert.match(roundLine(round(), USDC), /^Offers and bids close Oct 17/);
  assert.match(roundLine(round(), USDC, true), /^Offers and bids close Oct 17/);
  const off = roundLine(round(), USDC, false);
  assert.match(off, /no new offers or bids are taken/);
  assert.match(off, /Oct 17/);
  assert.match(off, /still settles/);
  assert.doesNotMatch(off, /^Offers and bids close/);
  // Only the taking of orders changes; the other phases say what they said.
  assert.equal(
    roundLine(round({ phase: "settling" }), USDC, false),
    roundLine(round({ phase: "settling" }), USDC),
  );
});

// ---- B17: plain-words disclosures, precision, plurals, time zones ---------------------------------------------------

test("Shares are counted in full precision and in the right number", () => {
  // The default lot is one whole Share: singular, not "1 Shares".
  assert.equal(copy.sharesPhrase(E18), "1 Share");
  assert.equal(copy.sharesPhrase(LOT), "100 Shares");
  assert.equal(copy.sharesPhrase(3n * E18 + E18 / 2n), "3.5 Shares");
  assert.equal(copy.sharesPhrase(0n), "0 Shares");
  // A unit under the old four-decimal cut still shows what really moves.
  assert.equal(copy.sharesPhrase(10n ** 13n), "0.00001 Shares");
  assert.equal(copy.sharesPhrase(E18 + 10n ** 13n), "1.00001 Shares");
  assert.equal(copy.sharesPhrase(1n), "0.000000000000000001 Shares");
  // The sentences built on it carry the same words.
  assert.equal(lotSizeLine(E18), "A lot is 1 Share.");
  assert.equal(lotSizeLine(10n ** 13n), "A lot is 0.00001 Shares.");
  assert.match(
    sellPlanLine(
      round(),
      { lots: 2n, level: 6 },
      { ...SELL_USDC, lotSize: 10n ** 13n },
    ),
    /This holds 2 lots \(0\.00002 Shares\) until/,
  );
  assert.match(
    sellPlanLine(
      round(),
      { lots: 1n, level: 6 },
      { ...SELL_USDC, lotSize: E18 },
    ),
    /This holds 1 lot \(1 Share\) until/,
  );
  assert.equal(
    sellRoomLine(funds({ saleCapacity: E18, shares: E18 }), E18),
    "You can offer up to 1 lot now (1 Share).",
  );
});

test("the buttons that collect Shares use the same count words", () => {
  for (const file of ["../ui/TradingCard.tsx", "../ui/TradingEarlier.tsx"]) {
    const source = read(file);
    assert.match(source, /Collect \$\{sharesPhrase\(due\.shares\)\}/, file);
    assert.doesNotMatch(source, /\) \}\s*Shares`/, file);
    assert.doesNotMatch(source, /shareUnits\(/, file);
  }
  const form = read("../ui/TradingListingForm.tsx");
  assert.doesNotMatch(form, /one lot of \$\{formatUnits/);
});

test("dates name their time zone", () => {
  const withZone = /\d{1,2}:\d{2} [AP]M (UTC|GMT[+-]?\d*|[A-Z]{2,5})\b/;
  assert.match(roundLine(round(), USDC), withZone);
  assert.match(roundLine(round({ phase: "settling" }), USDC), withZone);
  assert.match(nextRoundLine(OCT_14 + 7 * 86_400), withZone);
});

test("one always-visible line says trading does not fund the project or promise anything", () => {
  assert.equal(
    copy.NOT_FUNDING_LINE,
    "Selling and buying here moves existing Shares between holders. It does not fund the project and does not promise a buyer, a price or a return.",
  );
  const card = read("../ui/TradingCard.tsx");
  const at = card.indexOf("{NOT_FUNDING_LINE}");
  assert.ok(at > 0, "the card must render the line");
  // Not inside a collapsed disclosure: no MoreInfo is open between the last opening and the line.
  const before = card.slice(0, at);
  assert.ok(
    before.lastIndexOf("<MoreInfo") === -1 ||
      before.lastIndexOf("</MoreInfo>") > before.lastIndexOf("<MoreInfo"),
    "the line must sit outside every MoreInfo",
  );
});

test("a buyer is told what bought Shares are before bidding", () => {
  const notes = copy.buyerNotes().join(" ");
  assert.match(notes, /cannot be sent to anyone/);
  assert.match(notes, /only offer them again in a later round/);
  assert.match(notes, /can give out more Shares as pay/);
  assert.match(notes, /lower/);
  assert.match(notes, /get back less than you paid/);
  assert.match(notes, /large share of the vote/);
  // The vote delay comes from the one constant.
  assert.ok(
    [...copy.buyerNotes(), ...tradingLimits()].some((l) =>
      l.includes(`(${copy.voteDelayDays()})`),
    ),
  );
  assert.doesNotMatch(
    notes,
    /escrow|Payouts\.sol|kind \d|NIP|ActivationVoting|fee/i,
  );
  assert.equal(new Set(copy.buyerNotes()).size, copy.buyerNotes().length);
  assert.match(read("../ui/TradingCard.tsx"), /buyerNotes\(\)/);
});

test("the offer and bid previews say what is paid and when Shares arrive", () => {
  const plan = { lots: 3n, level: 6 };
  const sellLine = sellPlanLine(round(), plan, SELL_USDC);
  assert.match(
    sellLine,
    /round's single price for each lot that sells, never below your lowest price/,
  );
  const bidLine = bidPlanLine(round(), plan, USDC);
  assert.match(bidLine, /Nothing may fill/);
  assert.match(bidLine, /Bought Shares are collected in a separate step/);
});
