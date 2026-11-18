import assert from "node:assert/strict";
import test from "node:test";

import { BID_SENTENCES, bidAmountText, bidSummary } from "./bid-words.ts";

const USDC = { kind: "usdc", symbol: "USDC", decimals: 6 };
const CUSTOM = { kind: "custom", symbol: "dUSDC", decimals: 6 };
const Q96 = 1n << 96n;

test("the amount is the money the bid put in, read out of its fixed-point form", () => {
  assert.equal(bidAmountText(133_333n * 10n ** 6n * Q96, USDC), "133,333 USDC");
  assert.equal(bidAmountText(1_500_000n * Q96, USDC), "1.5 USDC");
});

test("an amount that cannot be named is left out, never guessed", () => {
  assert.equal(bidAmountText(0n, USDC), null);
  // A custom token's name and decimals are not known here, so no unit is invented for it.
  assert.equal(bidAmountText(5n * 10n ** 6n * Q96, CUSTOM), null);
});

test("every status the bid derivation can give has a sentence a person can act on", () => {
  for (const status of [
    "active",
    "outbid",
    "ended",
    "exited",
    "claimable",
    "settled",
  ]) {
    assert.ok(BID_SENTENCES[status].endsWith("."), status);
  }
});

test("a collected bid does not read as if nothing happened", () => {
  const text = bidSummary("settled", 100n * 10n ** 6n * Q96, USDC);
  assert.equal(
    text,
    "100 USDC offered. Nothing is left to collect from this bid.",
  );
  assert.doesNotMatch(text, /filled/i);
});

test("a status this page has never heard of says so instead of printing a code", () => {
  assert.match(bidSummary("mystery", 0n, USDC), /does not recognise/);
});
