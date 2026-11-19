// The reads and the plans built on them, against a stand-in node. Run with:
// node --experimental-strip-types --test src/pot/pot-reads.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { decodeCall } from "./abi-codec.ts";
import { PLAY_DOLLAR_ABI, TREASURY_ABI } from "./abis.generated.ts";
import { fakeChain } from "./fake-chain.mjs";
import {
  QUOTE_TOLERANCE_BPS,
  planBack,
  planTakeOut,
  planTeamTakeOut,
  teamCashEstimate,
  withTolerance,
} from "./pot-plans.ts";
import * as reads from "./pot-reads.ts";

const DOLLAR = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const TREASURY = "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9";
const VESTER = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";
const ME = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

test("quoteBack reads its four numbers", async () => {
  const { read, seen } = fakeChain({ quoteBack: [11_501n, 98n, 0n, 5n] });
  const quote = await reads.quoteBack(read, TREASURY, 100n);
  assert.deepEqual(quote, {
    shares: 11_501n,
    takeOutNow: 98n,
    locked: 0n,
    arriving: 5n,
  });
  assert.deepEqual(seen[0], { to: TREASURY, name: "quoteBack", args: [100n] });
});

test("feeFor, doorOpenNow, quoteTakeOut, teamValue, balances and claims", async () => {
  const { read } = fakeChain({
    feeFor: [2n],
    doorOpenNow: [false],
    quoteTakeOut: [9_000n, 0n, 7n],
    teamValue: [1234n],
    balanceOf: [55n],
    allowance: [66n],
    idsOf: [[1n, 3n]],
    claimable: [77n],
    vestedOf: [88n],
  });
  assert.equal(await reads.feeFor(read, TREASURY, 100n), 2n);
  assert.equal(await reads.doorOpenNow(read, TREASURY), false);
  assert.deepEqual(await reads.quoteTakeOut(read, TREASURY, ME, 5n), {
    cashNow: 9_000n,
    note: 0n,
    arrivingLeftBehind: 7n,
  });
  assert.equal(await reads.teamValue(read, TREASURY), 1234n);
  assert.equal(await reads.balanceOf(read, DOLLAR, ME), 55n);
  assert.equal(await reads.allowanceOf(read, DOLLAR, ME, TREASURY), 66n);
  assert.deepEqual(await reads.grantIdsOf(read, VESTER, ME), [1n, 3n]);
  assert.equal(await reads.claimableOf(read, VESTER, 1n), 77n);
  assert.equal(await reads.vestedOf(read, VESTER, 1n), 88n);
});

test("a read that fails or answers short throws; it never gives zero", async () => {
  await assert.rejects(() =>
    reads.quoteBack(
      async () => {
        throw new Error("node down");
      },
      TREASURY,
      1n,
    ),
  );
  await assert.rejects(() => reads.quoteBack(async () => "0x", TREASURY, 1n));
  await assert.rejects(
    () => reads.quoteBack(async () => "0xzz", TREASURY, 1n),
    /not readable/,
  );
  await assert.rejects(() =>
    reads.doorOpenNow(async () => `0x${"00".repeat(31)}02`, TREASURY),
  );
});

test("the dollar's pay-and-call is told by the interface id, and a dollar that does not answer has none", async () => {
  let asked;
  const yes = async (_to, data) => {
    asked = data;
    return `0x${"00".repeat(31)}01`;
  };
  assert.equal(await reads.dollarHasPayAndCall(yes, DOLLAR), true);
  // supportsInterface(bytes4 0xb0202a11)
  assert.equal(asked, `0x01ffc9a7b0202a11${"00".repeat(28)}`);
  assert.equal(
    await reads.dollarHasPayAndCall(async () => `0x${"00".repeat(32)}`, DOLLAR),
    false,
  );
  assert.equal(
    await reads.dollarHasPayAndCall(async () => {
      throw new Error("revert");
    }, DOLLAR),
    false,
  );
});

test("a Back is planned from the quote: minShares is a little under it, and on the play dollar it is one call", async () => {
  const { read } = fakeChain({
    quoteBack: [10_000n, 98n, 0n, 0n],
    supportsInterface: [true],
  });
  const plan = await planBack(read, {
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 100n,
    to: ME,
  });
  assert.equal(plan.minShares, 9_950n);
  assert.equal(plan.oneSignature, true);
  assert.equal(plan.calls.length, 1);
  assert.equal(
    decodeCall(PLAY_DOLLAR_ABI, plan.calls[0].data).name,
    "transferAndCall",
  );
});

test("a Back on a dollar with no pay-and-call is approve, then join, with the same guard", async () => {
  const { read } = fakeChain({
    quoteBack: [10_000n, 98n, 0n, 0n],
    supportsInterface: [false],
  });
  const plan = await planBack(read, {
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 100n,
    to: ME,
  });
  assert.equal(plan.oneSignature, false);
  assert.equal(plan.calls.length, 2);
  const join = decodeCall(TREASURY_ABI, plan.calls[1].data);
  assert.deepEqual([join.name, join.args[1]], ["join", 9_950n]);
});

test("a Back that would buy no Shares is refused before a signature", async () => {
  const { read } = fakeChain({ quoteBack: [0n, 0n, 0n, 0n] });
  assert.equal(
    await planBack(read, {
      dollar: DOLLAR,
      treasury: TREASURY,
      amount: 100n,
      payAndCall: true,
    }),
    null,
  );
});

test("a take-out is planned from the quote with a minimum-cash guard", async () => {
  const { read, seen } = fakeChain({ quoteTakeOut: [1_000_000n, 0n, 0n] });
  const plan = await planTakeOut(read, {
    treasury: TREASURY,
    holder: ME,
    shares: 5n,
    to: ME,
  });
  assert.equal(plan.minCash, 995_000n);
  const leave = decodeCall(TREASURY_ABI, plan.call.data);
  assert.deepEqual([leave.name, ...leave.args], ["leave", 5n, 995_000n, ME]);
  assert.equal(seen[0].name, "quoteTakeOut");
});

test("a take-out of nothing is refused, and a guard never falls to zero", async () => {
  const none = fakeChain({ quoteTakeOut: [0n, 0n, 0n] });
  assert.equal(
    await planTakeOut(none.read, {
      treasury: TREASURY,
      holder: ME,
      shares: 5n,
      to: ME,
    }),
    null,
  );
  const tiny = fakeChain({ quoteTakeOut: [1n, 0n, 0n] });
  const plan = await planTakeOut(tiny.read, {
    treasury: TREASURY,
    holder: ME,
    shares: 5n,
    to: ME,
  });
  assert.equal(plan.minCash, 1n);
});

test("a Team take-out goes by an estimate and a wider guard, and is refused when the estimate is zero", async () => {
  assert.equal(teamCashEstimate(10_058n, 3n * 10n ** 18n), 30_174n);
  const { read } = fakeChain({ teamValue: [10_000n] });
  const plan = await planTeamTakeOut(read, {
    treasury: TREASURY,
    shares: 2n * 10n ** 18n,
    to: ME,
  });
  assert.equal(plan.estimate, 20_000n);
  assert.equal(plan.minCash, 19_600n);
  const zero = fakeChain({ teamValue: [0n] });
  assert.equal(
    await planTeamTakeOut(zero.read, {
      treasury: TREASURY,
      shares: 10n ** 18n,
      to: ME,
    }),
    null,
  );
});

test("the tolerance rounds down and is half a percent", () => {
  assert.equal(QUOTE_TOLERANCE_BPS, 50n);
  assert.equal(withTolerance(1_000n, 50n), 995n);
  assert.equal(withTolerance(1n, 50n), 0n);
});
