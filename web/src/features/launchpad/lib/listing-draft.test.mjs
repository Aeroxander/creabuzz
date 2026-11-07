import assert from "node:assert/strict";
import { test } from "node:test";

import { listingFormDraft } from "./listing-draft.ts";

const MARKET = "0x00000000000000000000000000000000000000e5";
const LISTING = { enabled: false, minPrice: 0n, maxPrice: 0n, levels: 0 };
const present = {
  kind: "present",
  market: MARKET,
  listing: LISTING,
  round: null,
  wallet: { address: null, sell: null, bid: null },
};
const STOP = "Stop new trading rounds (settlement and claims continue)";
const base = {
  factoryKnown: true,
  failed: false,
  read: present,
  market: MARKET,
  quote: { decimals: 6, symbol: "USDC" },
  lotSize: 40n * 10n ** 18n,
  enabled: "on",
  minText: "1.6",
  maxText: "8",
  levelsText: "64",
};

test("the form's draft for a readable market is the listing, in the market's own units", () => {
  const result = listingFormDraft(base);
  assert.ok(
    "draft" in result,
    JSON.stringify(result, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
  assert.equal(result.draft.to, MARKET);
  assert.match(result.draft.title, /between 1\.60 and 8\.00 USDC/);
});

test("a market whose price token will not say its units can still be stopped, and nothing else", () => {
  // `useSecondary` answers this way when decimals() or symbol() stop working: unreadable, no facts, but the address.
  const blind = {
    ...base,
    read: {
      kind: "unreadable",
      reason:
        "the market's price token did not say its decimals and its symbol",
    },
    quote: null,
    lotSize: null,
  };
  const stop = listingFormDraft({ ...blind, enabled: "off" });
  assert.ok("draft" in stop, JSON.stringify(stop));
  assert.equal(stop.draft.to, MARKET);
  assert.equal(stop.draft.title, STOP);
  // Publishing prices needs the scale, so that stays refused, with the reason.
  const on = listingFormDraft(blind);
  assert.ok("problem" in on);
  assert.match(on.problem, /could not load the market/);
});

test("stopping needs a market to aim at: not one that is absent, unread or not yet known", () => {
  for (const over of [
    { read: { kind: "absent" }, market: null },
    {
      read: { kind: "unreadable", reason: "timeout" },
      market: null,
      quote: null,
    },
    { read: null, market: null },
    { factoryKnown: false, read: null, market: null },
  ]) {
    const result = listingFormDraft({ ...base, enabled: "off", ...over });
    assert.ok("problem" in result, JSON.stringify(over));
  }
});
