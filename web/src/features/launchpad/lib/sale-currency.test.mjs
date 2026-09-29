import assert from "node:assert/strict";
import test from "node:test";

import {
  currencyChoices,
  ETH,
  saleCurrencyFor,
  USDC_BY_CHAIN,
  usdcAddress,
} from "./sale-currency.ts";

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const OTHER = "0x9999999999999999999999999999999999999999";

test("empty and the zero address mean ETH, with 18 decimals", () => {
  for (const currency of [null, undefined, "", "  ", `0x${"0".repeat(40)}`]) {
    const c = saleCurrencyFor(currency, 11155111);
    assert.equal(c.kind, "eth", JSON.stringify(currency));
    assert.equal(c.symbol, "ETH");
    assert.equal(c.decimals, 18);
    assert.equal(c.value, "", "ETH is stored as the empty string");
  }
  assert.deepEqual(saleCurrencyFor("", 1), ETH);
});

test("a chain's USDC address is USDC with 6 decimals, in any letter case", () => {
  const c = saleCurrencyFor(SEPOLIA_USDC, "11155111");
  assert.equal(c.kind, "usdc");
  assert.equal(c.symbol, "USDC");
  assert.equal(c.decimals, 6);
  assert.equal(c.value, SEPOLIA_USDC.toLowerCase());
  assert.equal(
    saleCurrencyFor(SEPOLIA_USDC.toLowerCase(), 11155111).kind,
    "usdc",
  );
});

test("USDC on the wrong chain is NOT recognised as USDC", () => {
  // Sepolia's USDC address means nothing on Base: showing 'USDC' there would
  // label an unknown token with a symbol it may not have.
  assert.equal(saleCurrencyFor(SEPOLIA_USDC, 8453).kind, "custom");
});

test("any other token is kept as custom, never coerced to a choice", () => {
  const c = saleCurrencyFor(OTHER, 11155111);
  assert.equal(c.kind, "custom");
  assert.equal(c.value, OTHER);
  assert.equal(c.decimals, 6);
});

test("the local chain has USDC only when the caller supplies it", () => {
  assert.equal(usdcAddress(31337), null);
  assert.equal(usdcAddress(31337, "not an address"), null);
  assert.equal(usdcAddress(31337, OTHER), OTHER);
  assert.equal(saleCurrencyFor(OTHER, 31337, OTHER).kind, "usdc");
  assert.equal(saleCurrencyFor(OTHER, 31337).kind, "custom");
});

test("new sales are offered USDC and ETH where USDC is known, ETH alone otherwise", () => {
  assert.deepEqual(
    currencyChoices(11155111).map((c) => c.symbol),
    ["USDC", "ETH"],
  );
  assert.deepEqual(
    currencyChoices(31337).map((c) => c.symbol),
    ["ETH"],
  );
  assert.deepEqual(
    currencyChoices(31337, OTHER).map((c) => c.symbol),
    ["USDC", "ETH"],
  );
  assert.deepEqual(
    currencyChoices(999999).map((c) => c.symbol),
    ["ETH"],
  );
});

test("every built-in USDC address is a well-formed lowercase address", () => {
  for (const [chain, address] of Object.entries(USDC_BY_CHAIN)) {
    assert.match(address, /^0x[0-9a-f]{40}$/, `chain ${chain}`);
  }
});
