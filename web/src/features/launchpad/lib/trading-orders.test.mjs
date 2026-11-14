import assert from "node:assert/strict";
import { test } from "node:test";

import { bidCalls, placeOrder, sellCalls } from "./trading-orders.ts";
import { bidPlan, sellPlan } from "./trading-copy.ts";
import { MAX_ORDER_LOTS } from "@creaton/core/launchpad/secondary.ts";

const MARKET = `0x${"3a".repeat(20)}`;
const SHARES = `0x${"51".repeat(20)}`;
const QUOTE = `0x${"9c".repeat(20)}`;
const USD = 1_000_000n;
const LOT = 100n * 10n ** 18n;
const USDC = { quoteDecimals: 6, quoteSymbol: "USDC" };
const round = { minPrice: USD, step: 8_000n, levels: 8 };
const facts = { lotSize: LOT, sharesToken: SHARES, quoteToken: QUOTE };
const rich = {
  saleCapacity: 1n << 200n,
  shares: 1n << 200n,
  quote: 1n << 200n,
  quoteAllowance: 0n,
};

const APPROVE = "0x095ea7b3";
const word = (n) => n.toString(16).padStart(64, "0");
const approveData = (amount) =>
  `${APPROVE}${"0".repeat(24)}${MARKET.slice(2)}${word(amount)}`;

/** A sender that records every batch it is handed, and lands it unless told not to. */
function recorder(result = true) {
  const sent = [];
  return {
    sent,
    sendBatch: async (key, calls) => {
      sent.push({ key, calls });
      return result;
    },
  };
}

test("an offer is one step: the approval of exactly its Shares, then the offer, in one batch", async () => {
  const sender = recorder();
  const failures = [];
  const ok = await placeOrder(
    "trading-sell",
    () => sellCalls({ market: MARKET, roundId: 3n, lots: 2n, level: 1, facts }),
    sender.sendBatch,
    (m) => failures.push(m),
  );
  assert.equal(ok, true);
  assert.deepEqual(failures, []);
  assert.equal(
    sender.sent.length,
    1,
    "one send, not an approval and then an order",
  );
  const [{ key, calls }] = sender.sent;
  assert.equal(key, "trading-sell");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, SHARES);
  assert.equal(calls[0].data, approveData(2n * LOT));
  assert.equal(calls[1].to, MARKET);
  assert.match(calls[1].data, /^0x[0-9a-f]{8}/);
});

test("a step that did not land reports false, so the form stays open", async () => {
  const sender = recorder(false);
  const ok = await placeOrder(
    "trading-sell",
    () => sellCalls({ market: MARKET, roundId: 3n, lots: 2n, level: 1, facts }),
    sender.sendBatch,
    () => {},
  );
  assert.equal(ok, false);
});

test("every call is built before the first send: an order that cannot be encoded sends nothing and says why", async () => {
  const sender = recorder();
  const failures = [];
  // The plan refuses this count, so the form would never get here: this binds the guard behind the guard.
  const ok = await placeOrder(
    "trading-sell",
    () =>
      sellCalls({
        market: MARKET,
        roundId: 3n,
        lots: MAX_ORDER_LOTS + 1n,
        level: 0,
        facts,
      }),
    sender.sendBatch,
    (m) => failures.push(m),
  );
  assert.equal(ok, false);
  assert.equal(
    sender.sent.length,
    0,
    "no approval went out for an order that cannot be placed",
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nothing was sent/);
  const bidSender = recorder();
  const bidFailures = [];
  await placeOrder(
    "trading-bid",
    () =>
      bidCalls({
        market: MARKET,
        roundId: 3n,
        round,
        lots: MAX_ORDER_LOTS + 1n,
        level: 2,
        allowance: 0n,
        facts,
      }),
    bidSender.sendBatch,
    (m) => bidFailures.push(m),
  );
  assert.equal(bidSender.sent.length, 0);
  assert.equal(bidFailures.length, 1);
});

test("a send that throws is reported, never left as an unhandled rejection", async () => {
  const failures = [];
  const ok = await placeOrder(
    "trading-bid",
    () => [{ to: MARKET, data: "0x" }],
    async () => {
      throw new Error("the wallet went away");
    },
    (m) => failures.push(m),
  );
  assert.equal(ok, false);
  assert.deepEqual(failures, ["the wallet went away"]);
});

test("a bid approves what it holds and bids, in one batch", async () => {
  const sender = recorder();
  await placeOrder(
    "trading-bid",
    () =>
      bidCalls({
        market: MARKET,
        roundId: 3n,
        round,
        lots: 5n,
        level: 4,
        allowance: 0n,
        facts,
      }),
    sender.sendBatch,
    () => {},
  );
  assert.equal(sender.sent.length, 1);
  const { calls } = sender.sent[0];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, QUOTE);
  assert.equal(calls[0].data, approveData(5n * 1_032_000n));
  assert.equal(calls[1].to, MARKET);
});

test("an approval that already covers the bid is not sent again", () => {
  const holds = 5n * 1_032_000n;
  for (const allowance of [holds, holds + 1n, 1n << 255n]) {
    const calls = bidCalls({
      market: MARKET,
      roundId: 3n,
      round,
      lots: 5n,
      level: 4,
      allowance,
      facts,
    });
    assert.equal(calls.length, 1, `allowance ${allowance}`);
    assert.equal(calls[0].to, MARKET);
  }
});

test("a partial approval is cleared first, so a token that refuses non-zero to non-zero cannot wedge the retry", () => {
  const holds = 5n * 1_032_000n;
  const calls = bidCalls({
    market: MARKET,
    roundId: 3n,
    round,
    lots: 5n,
    level: 4,
    allowance: 1n,
    facts,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.to),
    [QUOTE, QUOTE, MARKET],
  );
  assert.equal(calls[0].data, approveData(0n));
  assert.equal(calls[1].data, approveData(holds));
});

test("a count the form plans is a count the calls can encode, and the form's cap is the contract's", () => {
  const cap = MAX_ORDER_LOTS.toString();
  const plan = sellPlan(round, cap, "1", { ...USDC, lotSize: LOT }, rich);
  assert.deepEqual(plan, { lots: MAX_ORDER_LOTS, level: 0 });
  assert.equal(
    sellCalls({ market: MARKET, roundId: 1n, ...plan, facts }).length,
    2,
  );
  const over = (MAX_ORDER_LOTS + 1n).toString();
  assert.ok(
    "problem" in sellPlan(round, over, "1", { ...USDC, lotSize: LOT }, rich),
  );
  assert.ok("problem" in bidPlan(round, over, "1.05", USDC, rich));
});
