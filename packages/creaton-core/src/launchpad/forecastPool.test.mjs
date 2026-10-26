import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  CLOSE_BEFORE,
  encodeBet,
  FORECAST_POOL_SIGNATURES,
  mayBetNo,
  payoutIfRight,
  poolOpen,
  poolSettleable,
  readMoneyForecast,
} from "./forecastPool.ts";
import { NO_APPEAL } from "./openBounty.ts";

const BEN = "0x000000000000000000000000000000000000be11";
const POOL = `0x${"f0".repeat(20)}`;
const ME = "0x0000000000000000000000000000000000000a11";
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

const record = (over = {}) => ({
  creator: BEN,
  openedAt: 0,
  deadline: 30 * 86_400,
  refundsFrom: 53 * 86_400,
  post: `0x${"00".repeat(32)}`,
  wordsHash: `0x${"00".repeat(32)}`,
  total: 100n,
  refunded: 0n,
  counting: 100n,
  claimCount: 0,
  runClaim: 0,
  runSince: 0,
  paidClaim: 0,
  court: false,
  appeal: NO_APPEAL,
  ...over,
});

test("the pool's calls are its own (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(FORECAST_POOL_SIGNATURES.bet), "0x8decaec0");
  assert.equal(sig(FORECAST_POOL_SIGNATURES.settle), "0x8df82800");
  assert.equal(sig(FORECAST_POOL_SIGNATURES.collect), "0x8d3c100a");
  assert.equal(sig(FORECAST_POOL_SIGNATURES.pools), "0xac4afa38");
  assert.equal(sig(FORECAST_POOL_SIGNATURES.owed), "0x1755ccfc");
  assert.equal(
    encodeBet(3n, true, 5_000_000n),
    "0x8decaec00000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000004c4b40",
  );
  assert.throws(() => encodeBet(3n, true, 0n), /above zero/);
  assert.throws(() => encodeBet(3n, true, 1_000_000_001n), /at most 1,000/);
});

test("bets close a day before the deadline, while work is winning, and once paid or settled", () => {
  const b = record();
  assert.equal(poolOpen(b, "open", b.deadline - CLOSE_BEFORE - 1), true);
  assert.equal(poolOpen(b, "open", b.deadline - CLOSE_BEFORE), false);
  assert.equal(poolOpen(record({ runClaim: 1 }), "open", 0), false);
  assert.equal(poolOpen(record({ paidClaim: 1 }), "open", 0), false);
  assert.equal(poolOpen(b, "yes", 0), false);
});

test("the creator and claimants may only bet that it will be paid", () => {
  const none = { funded: 0n, backs: 0, openClaim: 0 };
  assert.equal(
    mayBetNo(record(), BEN.toUpperCase().replace("0X", "0x"), none),
    false,
  );
  assert.equal(mayBetNo(record(), ME, none), true);
  assert.equal(mayBetNo(record(), ME, { ...none, openClaim: 2 }), false);
});

test("it settles once the bounty paid or its refunds opened", () => {
  assert.equal(poolSettleable(record({ paidClaim: 1 }), "open", false), true);
  assert.equal(poolSettleable(record(), "open", true), true);
  assert.equal(poolSettleable(record(), "open", false), false);
  assert.equal(poolSettleable(record({ paidClaim: 1 }), "yes", false), false);
});

test("being right pays your stake and its share of the other side", () => {
  assert.equal(payoutIfRight(30n, 40n, 20n), 45n);
  assert.equal(payoutIfRight(0n, 40n, 20n), 0n);
  assert.equal(payoutIfRight(10n, 0n, 20n), 10n);
});

test("a pool and the wallet's part are read from the chain", async () => {
  const chain = {
    call: async (to, data) => {
      assert.equal(to, POOL);
      const two = (s) =>
        encodeFunctionData(s, ["uint256", "address"], [3n, ME]);
      const answers = {
        [encodeFunctionData(FORECAST_POOL_SIGNATURES.pools, ["uint256"], [3n])]:
          words(40, 20, 1),
        [two(FORECAST_POOL_SIGNATURES.yesOf)]: words(30),
        [two(FORECAST_POOL_SIGNATURES.noOf)]: words(0),
        [two(FORECAST_POOL_SIGNATURES.owed)]: words(45),
        [two(FORECAST_POOL_SIGNATURES.collected)]: words(0),
      };
      return answers[data];
    },
  };
  assert.deepEqual(await readMoneyForecast(chain, POOL, 3n, ME), {
    yes: 40n,
    no: 20n,
    outcome: "yes",
    mine: { yes: 30n, no: 0n, owed: 45n, collected: false },
  });
});
