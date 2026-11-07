import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeMintTestTokens,
  GET_TEST_TOKENS_LABEL,
  isTestQuote,
  MINT_TEST_TOKENS_WHOLE,
  TEST_TOKEN_NOTE,
} from "./test-token.ts";

const TOKEN = `0x${"7e".repeat(20)}`;
const OTHER = `0x${"7f".repeat(20)}`;
const ME = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const env = { VITE_TEST_QUOTE_TOKENS: JSON.stringify({ 11155111: TOKEN }) };

test("a market's price token is the test token only when it is the one this build names for that network", () => {
  assert.equal(isTestQuote(TOKEN, 11155111, env), true);
  assert.equal(
    isTestQuote(TOKEN.toUpperCase().replace("0X", "0x"), 11155111, env),
    true,
  );
  assert.equal(isTestQuote(OTHER, 11155111, env), false);
  // Named for another network, or not named at all: never offered.
  assert.equal(isTestQuote(TOKEN, 1, env), false);
  assert.equal(isTestQuote(TOKEN, 11155111, {}), false);
  assert.equal(isTestQuote(TOKEN, null, env), false);
  assert.equal(isTestQuote("", 11155111, env), false);
  assert.equal(
    isTestQuote(TOKEN, 11155111, { VITE_TEST_QUOTE_TOKENS: "{" }),
    false,
  );
});

test("the mint call is mint(address,uint256) for a fixed 1,000 to the signed-in account, exactly as cast encodes it", () => {
  assert.equal(MINT_TEST_TOKENS_WHOLE, 1_000n);
  assert.equal(
    encodeMintTestTokens(ME, 18),
    "0x40c10f19000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000003635c9adc5dea00000",
  );
  assert.equal(
    encodeMintTestTokens(ME, 6),
    "0x40c10f19000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266000000000000000000000000000000000000000000000000000000003b9aca00",
  );
});

test("a mint for an address or units that make no sense is refused, not sent", () => {
  assert.throws(() => encodeMintTestTokens("0x12", 18), /address/);
  assert.throws(() => encodeMintTestTokens(ME, -1), /units/);
  assert.throws(() => encodeMintTestTokens(ME, 1.5), /units/);
  assert.throws(() => encodeMintTestTokens(ME, 37), /units/);
});

test("the words say the token is free and worth nothing, in plain terms", () => {
  assert.equal(GET_TEST_TOKENS_LABEL, "Get test tokens");
  assert.match(TEST_TOKEN_NOTE, /free/);
  assert.match(TEST_TOKEN_NOTE, /worth nothing/);
  assert.doesNotMatch(TEST_TOKEN_NOTE, /ERC|mint\b|VITE_|0x/i);
});

// The card is the seam for where the action shows: the hosted image cannot run it, so its source is read.
const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the Trading card offers the action only for the test token and only through its own send path", () => {
  const card = source("../ui/TradingCard.tsx");
  assert.match(card, /<TestTokenMint/);
  assert.match(card, /onSend=\{sender\.send\}/);
  const mint = source("../ui/TestTokenMint.tsx");
  assert.match(mint, /isTestQuote\(/);
  assert.match(mint, /if \(!isTestQuote\([^)]*\)\) return null;/);
  assert.match(mint, /encodeMintTestTokens\(/);
  assert.match(mint, /onSend\(\s*"trading-mint",\s*quote\.quoteToken,/);
});

test("a default build shows no trading UI at all: the card itself returns nothing", () => {
  const card = source("../ui/TradingCard.tsx");
  const guard = card.indexOf("if (!tradingOffered()) return null;");
  const body = card.indexOf("function TradingCardBody(");
  const mint = card.indexOf("<TestTokenMint");
  assert.ok(guard > 0 && body > guard && mint > body, "the guard comes first");
  // Nothing else mounts the card or the action.
  for (const file of ["../ui/LaunchDetailPage.tsx"]) {
    assert.doesNotMatch(source(file), /TestTokenMint/);
  }
});
