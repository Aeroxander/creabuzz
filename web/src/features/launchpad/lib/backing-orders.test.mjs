import assert from "node:assert/strict";
import test from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import {
  buyCalls,
  buyIssue,
  DEFAULT_SLIPPAGE_BPS,
  leaveCalls,
  openBackingCalls,
  postMilestoneCalls,
  redeemCalls,
  SLIPPAGE_CHOICES,
  sellCalls,
  settleMilestoneCalls,
  settleRoundCalls,
} from "./backing-orders.ts";

const POOL = `0x${"90".repeat(20)}`;
const TOKEN = `0x${"c0".repeat(20)}`;
const FACTORY = `0x${"fa".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const clocks = { chainNow: 1_000_000, browserNow: 900_000 };
const quote = { unitsOut: 1_000_000n, fee: 1n, toEscrow: 9n, priceAfter: 5n };
const token = { address: TOKEN, decimals: 6, symbol: "tTEST" };
const sel = (calls, i) => calls[i].data.slice(0, 10);
const approve = selectorOf("approve(address,uint256)");
const buy = selectorOf("buy(uint256,uint256,uint256)");

test("a buy approves exactly what is put in, then buys with a limit and a deadline", () => {
  const calls = buyCalls({
    pool: POOL,
    token: TOKEN,
    quoteIn: 5_000_000n,
    quote,
    allowance: 0n,
    slippageBps: 100,
    clocks,
  });
  assert.deepEqual(
    calls.map((c) => [c.to, c.data.slice(0, 10)]),
    [
      [TOKEN, approve],
      [POOL, buy],
    ],
  );
  // approve(pool, 5000000)
  assert.equal(BigInt(`0x${calls[0].data.slice(-64)}`), 5_000_000n);
  // buy(quoteIn, minUnitsOut, deadline): the limit is 1% under the quote and the deadline is after both clocks.
  const words = calls[1].data
    .slice(10)
    .match(/.{64}/g)
    .map((w) => BigInt(`0x${w}`));
  assert.deepEqual(words.slice(0, 2), [5_000_000n, 990_000n]);
  assert.equal(words[2], 1_001_800n);
});

test("an approval that already covers the buy is left alone; a smaller one is cleared first", () => {
  const enough = buyCalls({
    pool: POOL,
    token: TOKEN,
    quoteIn: 5_000_000n,
    quote,
    allowance: 5_000_000n,
    slippageBps: 100,
    clocks,
  });
  assert.deepEqual(
    enough.map((c) => c.data.slice(0, 10)),
    [buy],
  );
  const partial = buyCalls({
    pool: POOL,
    token: TOKEN,
    quoteIn: 5_000_000n,
    quote,
    allowance: 7n,
    slippageBps: 100,
    clocks,
  });
  assert.deepEqual(
    partial.map((c) => c.data.slice(0, 10)),
    [approve, approve, buy],
  );
  assert.equal(BigInt(`0x${partial[0].data.slice(-64)}`), 0n);
  assert.equal(BigInt(`0x${partial[1].data.slice(-64)}`), 5_000_000n);
});

test("a buy that cannot be encoded throws before any call exists, so no approval is left behind", () => {
  assert.throws(() =>
    buyCalls({
      pool: POOL,
      token: TOKEN,
      quoteIn: 0n,
      quote,
      allowance: 0n,
      slippageBps: 100,
      clocks,
    }),
  );
  assert.throws(() =>
    buyCalls({
      pool: POOL,
      token: TOKEN,
      quoteIn: 5n,
      quote,
      allowance: 0n,
      slippageBps: 20_000,
      clocks,
    }),
  );
});

test("every trade carries a limit: no choice of price move is zero percent of nothing, and the first is 1%", () => {
  assert.equal(DEFAULT_SLIPPAGE_BPS, 100);
  assert.ok(SLIPPAGE_CHOICES.some((c) => c.bps === DEFAULT_SLIPPAGE_BPS));
  for (const c of SLIPPAGE_CHOICES)
    assert.ok(c.bps > 0 && c.bps <= 1000, c.label);
});

test("a sale and a leave send one call each, with the limit taken off what was quoted", () => {
  const sold = sellCalls({
    pool: POOL,
    units: 3n,
    quote: { quoteOut: 1_000n, fee: 1n, refund: 0n, priceAfter: 1n },
    slippageBps: 100,
    clocks,
  });
  assert.equal(sold.length, 1);
  assert.equal(sold[0].to, POOL);
  assert.equal(sel(sold, 0), selectorOf("sell(uint256,uint256,uint256)"));
  assert.equal(BigInt(`0x${sold[0].data.slice(10 + 64, 10 + 128)}`), 990n);
  const left = leaveCalls({
    pool: POOL,
    quote: {
      quoteOut: 2_000n,
      fromCurve: 1n,
      fromEscrow: 1n,
      priceAfter: 1n,
      fee: 1n,
    },
    slippageBps: 100,
    clocks,
  });
  assert.equal(sel(left, 0), selectorOf("leave(uint256,uint256)"));
  assert.equal(BigInt(`0x${left[0].data.slice(10, 10 + 64)}`), 1_980n);
});

test("a founder's steps go to the right contract", () => {
  const record = "ab".repeat(32);
  const posted = postMilestoneCalls(POOL, record);
  assert.deepEqual(
    [posted[0].to, sel(posted, 0)],
    [POOL, selectorOf("postMilestone(bytes32)")],
  );
  assert.throws(() => postMilestoneCalls(POOL, "nope"));
  const now = openBackingCalls(FACTORY, DAO, { kind: "now" });
  assert.deepEqual(
    [now[0].to, sel(now, 0)],
    [FACTORY, selectorOf("open(address)")],
  );
  const round = openBackingCalls(FACTORY, DAO, {
    kind: "round",
    minimum: 25_000n,
  });
  assert.deepEqual(
    [round[0].to, sel(round, 0)],
    [FACTORY, selectorOf("openWithRound(address,uint128)")],
  );
  assert.equal(
    sel(settleMilestoneCalls(POOL), 0),
    selectorOf("resolveMilestone()"),
  );
  assert.equal(sel(settleRoundCalls(POOL), 0), selectorOf("seedFromAuction()"));
  assert.equal(sel(redeemCalls(POOL, 5n), 0), selectorOf("redeem(uint256)"));
});

test("the reasons a buy cannot go are said before anything is signed", () => {
  const snap = { holderEarlyLeft: null };
  const args = {
    quoteIn: 5_000_000n,
    quote,
    balance: 9_000_000n,
    snapshot: snap,
    token,
  };
  assert.equal(buyIssue(args), null);
  assert.match(buyIssue({ ...args, quoteIn: null }), /above zero/);
  assert.match(buyIssue({ ...args, quoteIn: 0n }), /above zero/);
  assert.match(buyIssue({ ...args, balance: 1_000_000n }), /You hold 1 tTEST/);
  assert.match(
    buyIssue({ ...args, snapshot: { holderEarlyLeft: 2_000_000n } }),
    /up to 2 tTEST more/,
  );
  assert.match(
    buyIssue({ ...args, quote: { ...quote, unitsOut: 0n } }),
    /too small/,
  );
  // With the balance unknown (no wallet read yet) the amount is not blocked on a guess.
  assert.equal(buyIssue({ ...args, balance: null }), null);
});
