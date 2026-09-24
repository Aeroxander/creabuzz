import assert from "node:assert/strict";
import test from "node:test";

import {
  amountBoundsIssue,
  composeBidPlan,
  floorPricePerToken,
  MAX_BID_AMOUNT_UNITS,
  maxBidPrice,
  parseBaseUnits,
  q96FromPrice,
  Q96,
  snapMaxPriceToTick,
  validateBid,
} from "./bidMath.ts";

// ---------------------------------------------------------------------------
// Golden vectors. Provenance is cited per test; every literal was read out of
// the WEB implementations this module ports (not re-derived from the port):
// - `web/src/features/launchpad/lib/launch-params.ts` + `launch-params.test.mjs`
// - `web/src/features/launchpad/lib/bid-tx.ts` + `bid-tx.test.mjs`
// - `web/src/features/launchpad/lib/amounts.ts` + `amounts.test.mjs`
// ---------------------------------------------------------------------------

const OWNER = "0x1111111111111111111111111111111111111111";

function plan(maxPriceQ96, amount) {
  return {
    maxPriceQ96,
    amount,
    owner: OWNER,
    prevTickPriceQ96: 100n,
    hookData: "0x",
  };
}

// ---------------------------------------------------------------------------
// snapMaxPriceToTick — port of web/.../bid-tx.ts
// ---------------------------------------------------------------------------

// Port of `web/src/features/launchpad/lib/bid-tx.test.mjs`
// "snapMaxPriceToTick snaps up to the grid and preserves aligned prices" —
// identical vectors.
test("snapMaxPriceToTick snaps up to the grid and preserves aligned prices (web bid-tx.test.mjs)", () => {
  // 100 spacing: 1050 -> 1100
  assert.equal(snapMaxPriceToTick(1050n, 100n), 1100n);
  // Already aligned: unchanged
  assert.equal(snapMaxPriceToTick(1100n, 100n), 1100n);
  // Zero spacing: passthrough
  assert.equal(snapMaxPriceToTick(1050n, 0n), 1050n);
  // The contract rule it mirrors: price % spacing == 0
  assert.equal(snapMaxPriceToTick(1050n, 100n) % 100n, 0n);
  // Large tick Q96 prices stay exact
  const q96big = (1n << 96n) * 1000n + 5n;
  assert.equal(snapMaxPriceToTick(q96big, 10n) % 10n, 0n);
});

// ---------------------------------------------------------------------------
// validateBid — port of web/.../bid-tx.ts (messages kept verbatim)
// ---------------------------------------------------------------------------

// Port of `web/src/features/launchpad/lib/bid-tx.test.mjs`
// "validateBid flags tick misalignment, sub-clearing and over-ceiling prices" —
// identical context and vectors.
test("validateBid flags tick misalignment, sub-clearing and over-ceiling prices (web bid-tx.test.mjs)", () => {
  const ctx = {
    tickSpacingQ96: 100n,
    clearingPriceQ96: 900n,
    supply: 10n ** 19n, // maxBidPrice well above 1100
  };
  // Off-grid max price
  let issues = validateBid(plan(1050n, 100n), ctx);
  assert.ok(
    issues.some(
      (i) => i.field === "maxPrice" && i.message.includes("tick grid"),
    ),
  );
  // At or below clearing
  issues = validateBid(plan(900n, 100n), ctx);
  assert.ok(issues.some((i) => i.message.includes("clearing price")));
  // Zero amount
  issues = validateBid(plan(1100n, 0n), ctx);
  assert.ok(issues.some((i) => i.field === "amount"));
  // Valid plan: no errors
  issues = validateBid(plan(1100n, 100n), ctx);
  assert.equal(issues.length, 0);
});

// Port of `web/src/features/launchpad/lib/bid-tx.test.mjs`
// "validateBid flags an over-ceiling price against the supply". The ceiling
// literals are that test's `ceilingForSmall` (= uint160.max, the flat bound
// through supply 2^62) and `ceilingForBig` (= web's `maxBidPriceImpl(1<<90)`).
test("validateBid flags an over-ceiling price against the supply (web bid-tx.test.mjs)", () => {
  const ceilingForSmall = 1461501637330902918203684832716283019655932542975n; // uint160.max
  const ctx = { tickSpacingQ96: 2n, clearingPriceQ96: 100n, supply: 1n << 40n };
  const issues = validateBid(plan(ceilingForSmall + 1n, 1n), ctx);
  assert.ok(issues.some((i) => i.message.includes("ceiling")));

  const ceilingForBig = 340282366920938463463374607431768211456n;
  const ctx2 = {
    tickSpacingQ96: 2n,
    clearingPriceQ96: 100n,
    supply: 1n << 90n,
  };
  const issues2 = validateBid(plan(ceilingForBig + 1n, 1n), ctx2);
  assert.ok(issues2.some((i) => i.message.includes("ceiling")));
});

// Desktop composition of the web dialog's clearing-read fallback
// (`web/src/features/launchpad/ui/RecordBidDialog.tsx`: `clearing ?? 0n` plus
// filtering the clearing issue out when the read failed) — `null` clears the
// check instead of guessing, while the contract still enforces it onchain.
test("validateBid skips the clearing rule when the clearing price is unreadable (web RecordBidDialog fallback)", () => {
  const ctx = {
    tickSpacingQ96: 100n,
    clearingPriceQ96: null,
    supply: null,
  };
  const issues = validateBid(plan(1100n, 100n), ctx);
  assert.deepEqual(issues, []);
});

// ---------------------------------------------------------------------------
// maxBidPrice — port of web/.../launch-params.ts (`MaxBidPriceLib`)
// ---------------------------------------------------------------------------

// Vectors from `web/src/features/launchpad/lib/bid-tx.test.mjs`
// ("Small supply => MAX_BID_PRICE is uint160.max (the liquidity bound applies
// only above 2^62)" / "A huge supply tightens the bound far below uint160.max")
// and `web/src/features/launchpad/lib/launch-params.test.mjs`
// ("tick spacing floor and ceiling" / "a threshold nobody can reach is
// blocking, an unreachable-at-floor one warns" — both run against
// `standardLaunchPreset({ startBlock: 1_000_000n })`, whose supply is 2e26).
test("maxBidPrice matches the web ceiling vectors (web launch-params.test.mjs + bid-tx.test.mjs)", () => {
  const uint160max = 1461501637330902918203684832716283019655932542975n;
  // No supply, no ceiling (web launch-params.ts `maxBidPrice`).
  assert.equal(maxBidPrice(0n), 0n);
  // Small supply: the flat uint160 ceiling (`ceilingForSmall`).
  assert.equal(maxBidPrice(1n << 40n), uint160max);
  // The flat branch runs through 2^62 inclusive (web launch-params.ts bound).
  assert.equal(maxBidPrice(1n << 62n), uint160max);
  assert.equal(
    maxBidPrice((1n << 62n) + 1n),
    1461501637330902917886772182659225669350476218367n,
  );
  // Huge supply: tightened far below uint160 (`ceilingForBig`).
  assert.equal(
    maxBidPrice(1n << 90n),
    340282366920938463463374607431768211456n,
  );

  // The web preset supply (2e26) and its two derived bounds:
  const supply = 200000000000000000000000000n; // standardLaunchPreset supply
  const ceiling = 13037030248540710951966677931853632954256n;
  assert.equal(maxBidPrice(supply), ceiling);
  // "tick spacing floor and ceiling": a 2^161 tick spacing must exceed the
  // ceiling (that is what makes the web vector blocking).
  assert.ok(maxBidPrice(supply) < 1n << 161n);
  // "a threshold nobody can reach": the max this supply could ever raise.
  assert.equal(
    (supply * maxBidPrice(supply)) / Q96,
    32910091146424120842717260756553478092n,
  );
});

// ---------------------------------------------------------------------------
// Q96 fixed-point — port of web/.../launch-params.ts
// ---------------------------------------------------------------------------

// Port of `web/src/features/launchpad/lib/launch-params.test.mjs`
// "Q96 conversion round-trips against the contract's price scale" — same
// relational bounds, with the exact values the web implementation produced
// pinned as literals.
test("Q96 conversion round-trips against the contract's price scale (web launch-params.test.mjs)", () => {
  const price = q96FromPrice(1n, 18n, 6n); // 1 USD per whole 18dp token
  assert.equal(price, 79228162514264337n);
  // Integer division truncates, so the round-trip is exact to within a part per
  // million of the Q96 unit — far below any price the auction can resolve.
  const roundTrip = (price * 10n ** 18n) / 10n ** 6n;
  const drift = roundTrip > Q96 ? roundTrip - Q96 : Q96 - roundTrip;
  assert.ok(drift * 1_000_000n <= Q96, `round-trip drifted by ${drift}`);
  // Linear in the whole price, up to the same integer truncation.
  const triple = q96FromPrice(3n, 18n, 6n);
  assert.equal(triple, 237684487542793012n);
  const expected = 3n * price;
  const gap = triple > expected ? triple - expected : expected - triple;
  assert.ok(gap <= 3n, `scaling drifted by ${gap}`);
  // And the display helper inverts it back to currency smallest units, to
  // within one smallest unit (a hundredth of a cent).
  const shown = floorPricePerToken(price, 18n);
  assert.equal(shown, 999999n);
  const cents = shown > 10n ** 6n ? shown - 10n ** 6n : 10n ** 6n - shown;
  assert.ok(cents <= 2n, `shown ${shown} is not within two cents of $1.00`);
});

// ---------------------------------------------------------------------------
// parseBaseUnits — port of web/.../amounts.ts `toAtomic`
// ---------------------------------------------------------------------------

// Vectors from `web/src/features/launchpad/lib/amounts.test.mjs`
// ("unknown is unknown, not zero": `toAtomic("12.5") === null` and friends).
test("parseBaseUnits matches web's toAtomic (web amounts.test.mjs)", () => {
  assert.equal(parseBaseUnits("12.5"), null);
  assert.equal(parseBaseUnits(""), null);
  assert.equal(parseBaseUnits("not a number"), null);
  assert.equal(parseBaseUnits(null), null);
  assert.equal(parseBaseUnits(undefined), null);
  assert.equal(parseBaseUnits("1000000"), 1_000_000n);
  assert.equal(parseBaseUnits(" 50000000000 "), 50_000_000_000n);
  assert.equal(parseBaseUnits(123n), 123n);
});

// ---------------------------------------------------------------------------
// Amount bounds — uint128 calldata width (desktop extension of the web checks)
// ---------------------------------------------------------------------------

test("amountBoundsIssue enforces the uint128 bid-amount calldata bound", () => {
  // submitBid's `amount` is a uint128 (`./evmCalls.ts` SUBMIT_BID_TYPES;
  // `encodeSubmitBid` rejects wider values deep in ABI encoding).
  assert.equal(MAX_BID_AMOUNT_UNITS, 340282366920938463463374607431768211455n);
  assert.equal(amountBoundsIssue(MAX_BID_AMOUNT_UNITS), null);
  const tooWide = amountBoundsIssue(MAX_BID_AMOUNT_UNITS + 1n);
  assert.ok(tooWide);
  assert.equal(tooWide.field, "amount");
  assert.equal(tooWide.severity, "error");
});

// ---------------------------------------------------------------------------
// composeBidPlan — the form seam the dialog binds
// ---------------------------------------------------------------------------

test("composeBidPlan snaps the max price up and defaults the hint to the floor", () => {
  // The snap-up vector is web bid-tx.test.mjs's 1050 -> 1100 at spacing 100;
  // the default hint is web bid-tx.test.mjs's "bidPlanWithDefaultHint keeps an
  // explicit hint and fills the floor otherwise".
  const composed = composeBidPlan({
    budget: "50000000000",
    maxPrice: "1050",
    owner: OWNER,
    floorPriceQ96: 4_294_967_297n,
    tickSpacingQ96: 100n,
  });
  assert.deepEqual(composed.issues, []);
  assert.ok(composed.plan);
  assert.equal(composed.plan.maxPriceQ96, 1100n);
  assert.equal(composed.plan.amount, 50_000_000_000n);
  assert.equal(composed.plan.owner, OWNER);
  assert.equal(composed.plan.hookData, "0x");
  assert.equal(composed.plan.prevTickPriceQ96, 4_294_967_297n);
});

test("composeBidPlan reports parse failures per field and still checks the rest", () => {
  const composed = composeBidPlan({
    budget: "abc",
    maxPrice: "12.5", // web amounts.test.mjs's non-integer vector
    owner: OWNER,
    floorPriceQ96: 100n,
    tickSpacingQ96: 10n,
  });
  assert.equal(composed.plan, null);
  assert.deepEqual(composed.issues.map((i) => i.field).sort(), [
    "amount",
    "maxPrice",
  ]);
  for (const issue of composed.issues) assert.equal(issue.severity, "error");
});

test("composeBidPlan surfaces the amount and clearing rules as field errors", () => {
  const zeroBudget = composeBidPlan({
    budget: "0",
    maxPrice: "1100",
    owner: OWNER,
    floorPriceQ96: 100n,
    tickSpacingQ96: 100n,
  });
  assert.ok(
    zeroBudget.issues.some(
      (i) => i.field === "amount" && i.message.includes("greater than zero"),
    ),
  );

  const belowClearing = composeBidPlan({
    budget: "1",
    maxPrice: "1100",
    owner: OWNER,
    floorPriceQ96: 100n,
    tickSpacingQ96: 100n,
    clearingPriceQ96: 1200n,
  });
  assert.ok(
    belowClearing.issues.some((i) => i.message.includes("clearing price")),
  );
  // Unread clearing: the rule is left to the contract (web fallback).
  const unreadClearing = composeBidPlan({
    budget: "1",
    maxPrice: "1100",
    owner: OWNER,
    floorPriceQ96: 100n,
    tickSpacingQ96: 100n,
    clearingPriceQ96: null,
  });
  assert.deepEqual(unreadClearing.issues, []);
});
