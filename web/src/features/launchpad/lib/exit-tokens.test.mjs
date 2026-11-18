import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCurrencyAnswer,
  exitTokensFor,
  formatTokenAmount,
} from "./exit-tokens.ts";

const ETH = `0x${"00".repeat(20)}`;
const USDC = `0x${"1c".repeat(20)}`;
const word = (address) => `0x${address.slice(2).padStart(64, "0")}`;

test("a sale's currency answer is one word holding an address", () => {
  assert.equal(decodeCurrencyAnswer(word(USDC)), USDC);
  assert.equal(decodeCurrencyAnswer(word(ETH)), ETH);
});

test("anything else is not an answer and never becomes a token list", () => {
  for (const bad of [
    "0x",
    "",
    "0x1234",
    // Stray bytes above the address: not an address word.
    `0x${"ff".repeat(12)}${"1c".repeat(20)}`,
    // Too long.
    `${word(USDC)}00`,
    // Not hex.
    `0x${"zz".repeat(32)}`,
  ]) {
    assert.throws(() => decodeCurrencyAnswer(bad), /did not say what currency/);
  }
});

test("while the sale's currency is being read there is no exit list: leaving it off would burn the Shares and forfeit it", () => {
  assert.deepEqual(
    exitTokensFor({ hasAuction: true, currency: { state: "pending" } }),
    { status: "reading" },
  );
});

test("a failed currency read is an error with its message, never a quiet ETH-only list", () => {
  assert.deepEqual(
    exitTokensFor({
      hasAuction: true,
      currency: { state: "error", message: "node down" },
    }),
    { status: "failed", message: "node down" },
  );
});

test("a read currency joins ETH in the list, in the order the contract requires", () => {
  const result = exitTokensFor({
    hasAuction: true,
    currency: {
      state: "success",
      address: USDC.toUpperCase().replace("0X", "0x"),
    },
  });
  assert.deepEqual(result, { status: "ready", tokens: [ETH, USDC] });
});

test("an ETH sale pays ETH once; a project with no sale pays ETH only", () => {
  assert.deepEqual(
    exitTokensFor({
      hasAuction: true,
      currency: { state: "success", address: ETH },
    }),
    { status: "ready", tokens: [ETH] },
  );
  assert.deepEqual(
    exitTokensFor({ hasAuction: false, currency: { state: "pending" } }),
    { status: "ready", tokens: [ETH] },
  );
});

test("with no sale contract to ask, the currency the launch record names is still paid out", () => {
  // A DAO bound without a linked sale still holds that money: leaving it off would burn the Shares and forfeit it.
  assert.deepEqual(
    exitTokensFor({
      hasAuction: false,
      recordCurrency: USDC,
      currency: { state: "pending" },
    }),
    { status: "ready", tokens: [ETH, USDC] },
  );
  // A record that names ETH, nothing, or something that is not an address adds nothing.
  for (const none of [null, "", ETH, "tokens"]) {
    assert.deepEqual(
      exitTokensFor({
        hasAuction: false,
        recordCurrency: none,
        currency: { state: "pending" },
      }),
      { status: "ready", tokens: [ETH] },
    );
  }
});

test("amounts use the token's own decimals", () => {
  assert.equal(
    formatTokenAmount(12_340_000n, { symbol: "USDC", decimals: 6 }),
    "12.34 USDC",
  );
  assert.equal(
    formatTokenAmount(10n ** 18n, { symbol: "ETH", decimals: 18 }),
    "1 ETH",
  );
  assert.equal(
    formatTokenAmount(5_000_000n, { symbol: null, decimals: 6 }),
    "5 tokens",
  );
});

test("a token that did not say its decimals is shown raw, not at a guessed scale", () => {
  const text = formatTokenAmount(12_340_000n, {
    symbol: "USDC",
    decimals: null,
  });
  assert.equal(text, "12340000 raw units of USDC");
  // The old fallback printed this as 0.00000000001234 USDC.
  assert.doesNotMatch(text, /0\.0000/);
  assert.equal(
    formatTokenAmount(7n, { symbol: null, decimals: null }),
    "7 raw units",
  );
});
