import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cancelAllNonce,
  composeSellOffer,
  leavingLine,
  offerLine,
  pricePerShare,
  salesStateLine,
} from "./matched-exit-copy.ts";

const WAD = 10n ** 18n;
const DAY = 86_400;
const input = (over = {}) => ({
  amountText: "10",
  priceText: "1.5",
  daysText: "7",
  free: 40n * WAD,
  chainTime: 1_790_000_000,
  nowMs: 1_790_000_000_123,
  minNonce: 0n,
  chainId: 31337,
  exchange: `0x${"e1".repeat(20)}`,
  sharesToken: `0x${"05".repeat(20)}`,
  seller: `0x${"06".repeat(20)}`,
  ...over,
});

test("where sales stand reads as one plain sentence, and nothing when the Shares are not locked", () => {
  assert.equal(salesStateLine("unlocked", null), null);
  assert.match(salesStateLine("off", null), /30 days after it passes/);
  assert.match(
    salesStateLine("announced", Date.UTC(2026, 10, 30) / 1000),
    /They can start on Nov 30, 2026\./,
  );
  assert.match(salesStateLine("ready", null), /Anyone can switch them on/);
  assert.match(
    salesStateLine("on", null),
    /goes to the seller, not the project/,
  );
  assert.match(salesStateLine("other", null), /doesn't know/);
});

test("an offer says how many, for how much, each, from whom and until when", () => {
  const offer = {
    amount: 4n * WAD,
    price: 6_000_000n,
    expiry: Date.UTC(2026, 11, 3) / 1000,
  };
  assert.equal(pricePerShare(offer), 1_500_000n);
  assert.equal(
    offerLine(offer, "Ann"),
    "4 Shares for 6 USDC (1.5 USDC each), from Ann, until Dec 3, 2026.",
  );
  assert.equal(
    leavingLine(1_230_000n),
    "Leaving pays about 1.23 USDC per Share right now.",
  );
  assert.equal(leavingLine(0n), "Leaving pays no USDC right now.");
  assert.equal(leavingLine(null), null);
});

test("the seller's form becomes the terms they sign: the whole price, an expiry from the chain's clock, a rising number", () => {
  const made = composeSellOffer(input());
  assert.equal(made.total, 15_000_000n);
  assert.deepEqual(made.terms, {
    chainId: 31337,
    exchange: input().exchange,
    shares: input().sharesToken,
    seller: input().seller,
    amount: 10n * WAD,
    price: 15_000_000n,
    expiry: 1_790_000_000 + 7 * DAY,
    nonce: 1_790_000_000_123n,
  });
  assert.equal(
    composeSellOffer(input({ minNonce: 1n << 64n })).terms.nonce,
    1n << 64n,
    "never below what the exchange still takes",
  );
});

test("what to fix is said plainly: too many, locked, nothing, too cheap, or how long", () => {
  const problem = (over) => composeSellOffer(input(over)).problem;
  assert.match(problem({ amountText: "41" }), /up to 40 Shares/);
  assert.match(problem({ free: 0n }), /no Shares you can sell/);
  assert.match(problem({ amountText: "0" }), /how many Shares/);
  assert.match(problem({ amountText: "ten" }), /number/);
  assert.match(problem({ priceText: "1.1234567" }), /at most 6 decimal places/);
  assert.match(
    problem({ amountText: "0.0000001", priceText: "0.000001" }),
    /too small/,
  );
  for (const daysText of ["0", "91", "", "1.5", "seven"]) {
    assert.match(problem({ daysText }), /from 1 to 90/, daysText);
  }
});

test("cancelling all covers every offer the seller made", () => {
  assert.equal(cancelAllNonce([]), null);
  assert.equal(
    cancelAllNonce([{ nonce: 5n }, { nonce: 9n }, { nonce: 7n }]),
    10n,
  );
});
