import assert from "node:assert/strict";
import test from "node:test";

import { formatMoney, formatQ96PerToken } from "./amounts.ts";
import { Q96 } from "./launch-params.ts";
import { priceToQ96, unitsToPlain } from "./sale-plans.ts";
import { ETH, usdcCurrency } from "./sale-currency.ts";
import { patchForPrice, patchForRaiseTarget } from "./wizard.ts";

// The wizard's money maths for an ETH sale (18 decimals) — the same functions
// USDC (6 decimals) uses, only with the currency's decimals passed through.

const SUPPLY = "200000000"; // whole tokens sold

test("an ETH price becomes a deployable floor on a clean tick grid", () => {
  const patch = patchForPrice("0.000004", "fixed-price", SUPPLY, 18);
  assert.ok(patch, "0.000004 ETH a token must be priceable");
  const floor = BigInt(patch.floorPrice);
  const tick = BigInt(patch.tickSpacing);
  assert.ok(floor > 1n << 32n, "the auction needs a floor above 2^32 in Q96");
  assert.equal(floor % tick, 0n, "floor sits on the tick grid");
  // The floor snaps DOWN onto the tick grid, so it may sit a hair under the
  // typed price; what the founder reads is still the price they typed, and the
  // error is far below anything a bid could notice.
  assert.equal(
    formatQ96PerToken(floor, { currencyDecimals: 18, unit: "ETH" }),
    "0.000004 ETH",
  );
  const typed = priceToQ96("0.000004", 18);
  assert.ok(floor <= typed, "snapped down, never above the typed price");
  assert.ok(
    (typed - floor) * 1_000_000n < typed,
    "within one part per million of the typed price",
  );
});

test("a fixed-price ETH sale graduates at the whole floor raise, in wei", () => {
  const patch = patchForPrice("0.000004", "fixed-price", SUPPLY, 18);
  // 200,000,000 tokens x 0.000004 ETH = 800 ETH (to the tick grid's rounding).
  const raised = BigInt(patch.requiredRaised);
  const eth = Number(raised / 10n ** 15n) / 1000;
  assert.ok(Math.abs(eth - 800) < 0.01, `expected ~800 ETH, got ${eth}`);
  assert.equal(formatMoney(raised, ETH), "800 ETH");
});

test("a raise target in ETH reads back as itself", () => {
  const patch = patchForRaiseTarget("120", "graduating-auction", SUPPLY, 18);
  assert.ok(patch);
  assert.equal(BigInt(patch.requiredRaised), 120n * 10n ** 18n);
  assert.equal(unitsToPlain(patch.requiredRaised, 18), "120");
});

test("the same price text means different money in ETH and USDC", () => {
  const eth = patchForPrice("0.01", "fixed-price", SUPPLY, 18);
  const usdc = patchForPrice("0.01", "fixed-price", SUPPLY, 6);
  // 0.01 ETH per token is 10^12 times more than 0.01 USDC: never mix the units.
  assert.equal(
    BigInt(eth.floorPrice) / BigInt(usdc.floorPrice) >= 10n ** 11n,
    true,
  );
});

test("more decimals than the currency holds is refused, not rounded", () => {
  assert.equal(priceToQ96("0.0000001", 6), null, "USDC has 6 decimals");
  assert.notEqual(priceToQ96("0.0000001", 18), null, "ETH has 18");
  assert.equal(priceToQ96("abc", 18), null);
  assert.equal(priceToQ96("0", 18), null);
  assert.equal(priceToQ96("-1", 18), null);
});

test("a plain price converts to the Q96 the auction reads", () => {
  // 1 whole token costs 1 ETH = 1e18 wei per 1e18 token units = 1 wei/unit.
  assert.equal(priceToQ96("1", 18), Q96);
  // USDC: 1 USDC (1e6 units) per whole token = 1e-12 units per token unit.
  assert.equal(priceToQ96("1", 6), (10n ** 6n * Q96) / 10n ** 18n);
});

test("ETH prices print with enough digits not to round to zero", () => {
  const q96 = priceToQ96("0.000004", 18);
  assert.equal(
    formatQ96PerToken(q96, { currencyDecimals: 18, unit: "ETH" }),
    "0.000004 ETH",
  );
  // USDC keeps its dollar prefix and two decimals from a cent up.
  assert.equal(
    formatQ96PerToken(priceToQ96("0.01", 6), { currencyDecimals: 6 }),
    "$0.01",
  );
  assert.equal(formatMoney(400000000000000n, ETH), "0.0004 ETH");
  assert.equal(
    formatMoney("300000000000", usdcCurrency(`0x${"1".repeat(40)}`)),
    "300,000 USDC",
  );
});
