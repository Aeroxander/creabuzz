import assert from "node:assert/strict";
import test from "node:test";

import { tradingOffered, tradingTrialOn } from "./trading-offered.ts";

const FACTORY = `0x${"3a".repeat(20)}`;
const named = JSON.stringify({ 31337: FACTORY });
const ON = { VITE_SECONDARY_MARKET_FACTORY: named, VITE_TRADING_TRIAL: "1" };

test("a default build offers no trading card at all", () => {
  assert.equal(tradingOffered({}), false);
  assert.equal(tradingOffered(undefined), false);
  assert.equal(tradingOffered({ VITE_CONTRIBUTOR_ONLY: "1" }), false);
});

test("a named factory alone offers nothing: the explicit switch is also needed", () => {
  assert.equal(tradingOffered({ VITE_SECONDARY_MARKET_FACTORY: named }), false);
  for (const off of ["", " ", "0", "true", "yes", "11"]) {
    assert.equal(
      tradingOffered({ ...ON, VITE_TRADING_TRIAL: off }),
      false,
      JSON.stringify(off),
    );
  }
});

test("the switch alone offers nothing: there must be a market to read", () => {
  assert.equal(tradingOffered({ VITE_TRADING_TRIAL: "1" }), false);
  assert.equal(
    tradingOffered({
      VITE_TRADING_TRIAL: "1",
      VITE_SECONDARY_MARKET_FACTORY: "",
    }),
    false,
  );
  assert.equal(
    tradingOffered({
      VITE_TRADING_TRIAL: "1",
      VITE_SECONDARY_MARKET_FACTORY: "  ",
    }),
    false,
  );
  // A setting that names nothing usable is no setting.
  for (const bad of ["{", "[]", '{"31337":"nope"}']) {
    assert.equal(
      tradingOffered({
        VITE_TRADING_TRIAL: "1",
        VITE_SECONDARY_MARKET_FACTORY: bad,
      }),
      false,
      bad,
    );
  }
});

test("a build that names a factory and sets the switch offers the card, for any network", () => {
  assert.equal(tradingOffered(ON), true);
  assert.equal(tradingTrialOn(ON), true);
  assert.equal(tradingTrialOn({ VITE_TRADING_TRIAL: " 1 " }), true);
  // For another network than the project's: the card is there to say trading is not set up on that one.
  assert.equal(
    tradingOffered({
      VITE_TRADING_TRIAL: "1",
      VITE_SECONDARY_MARKET_FACTORY: JSON.stringify({ 1: FACTORY }),
    }),
    true,
  );
});

test("the contributor-only hosted build offers trading once the trial switch and a factory are set, and not before", () => {
  // The contributor-only image makes raises off; trading no longer depends on raises.
  assert.equal(tradingOffered({ ...ON, VITE_CONTRIBUTOR_ONLY: "1" }), true);
  assert.equal(
    tradingOffered({
      VITE_CONTRIBUTOR_ONLY: "1",
      VITE_SECONDARY_MARKET_FACTORY: named,
    }),
    false,
  );
});
