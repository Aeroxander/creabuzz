import assert from "node:assert/strict";
import test from "node:test";

import { tradingOffered } from "./trading-offered.ts";

const FACTORY = `0x${"3a".repeat(20)}`;
const named = JSON.stringify({ 31337: FACTORY });

test("a build that names no market factory offers no trading card at all", () => {
  assert.equal(tradingOffered({}), false);
  assert.equal(tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: "" }), false);
  assert.equal(tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: "  " }), false);
  // A setting that names nothing usable is no setting.
  assert.equal(tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: "{" }), false);
  assert.equal(tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: "[]" }), false);
  assert.equal(
    tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: '{"31337":"nope"}' }),
    false,
  );
});

test("a build that names a factory, for any network, offers the card", () => {
  assert.equal(tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: named }), true);
  // For another network than the project's: the card is there to say trading is not set up on that one.
  assert.equal(
    tradingOffered({
      VITE_SECONDARY_MARKET_FACTORY: JSON.stringify({ 1: FACTORY }),
    }),
    true,
  );
});

test("the contributor-only hosted build never offers trading, even if a factory is named", () => {
  assert.equal(
    tradingOffered({
      VITE_CONTRIBUTOR_ONLY: "1",
      VITE_SECONDARY_MARKET_FACTORY: named,
    }),
    false,
  );
});
