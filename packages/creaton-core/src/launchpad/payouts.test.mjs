import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  declarePayoutDecision,
  PAYOUTS_SIGNATURES,
  readPayouts,
  SPLIT_NOTICE,
  startPayoutsDecision,
} from "./payouts.ts";
import { encodeCall0 } from "./work.ts";

const DAO = "0x00000000000000000000000000000000000000d0";
const FACTORY = "0x00000000000000000000000000000000000000f0";
const MODULE = "0x00000000000000000000000000000000000000e0";
const USDC = "0x0000000000000000000000000000000000000005";
const ME = "0x0000000000000000000000000000000000000a11";
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

test("the selectors are the contracts' (cast sig goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(PAYOUTS_SIGNATURES.distribute), "0xe4fc6b6d");
  assert.equal(sig(PAYOUTS_SIGNATURES.declare), "0x18219ab8");
  assert.equal(sig(PAYOUTS_SIGNATURES.withdraw), "0x51cff8d9");
  assert.equal(sig(PAYOUTS_SIGNATURES.owed), "0xdf18e047");
  assert.equal(sig(PAYOUTS_SIGNATURES.create), "0x30afdbab");
  assert.equal(sig(PAYOUTS_SIGNATURES.predict), "0xfd1a8cf8");
  assert.equal(sig(PAYOUTS_SIGNATURES.daoPayouts), "0xa247bc32");
  assert.equal(sig(PAYOUTS_SIGNATURES.setPayouts), "0x622c7e86");
  assert.equal(sig(PAYOUTS_SIGNATURES.applySplit), "0x64987cfd");
});

test("starting payouts is one batch that makes the module and names it (cast calldata golden)", () => {
  const draft = startPayoutsDecision({
    dao: DAO,
    factory: FACTORY,
    predicted: MODULE,
    currency: USDC,
    splitBps: 5_000,
  });
  assert.equal(draft.to, DAO);
  assert.equal(
    draft.data,
    "0x11c76fd9000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000006430afdbab00000000000000000000000000000000000000000000000000000000000000d0000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000024622c7e8600000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(draft.title, "Pay holders 50% of revenue");
  assert.throws(
    () =>
      startPayoutsDecision({
        dao: DAO,
        factory: FACTORY,
        predicted: MODULE,
        currency: USDC,
        splitBps: 0,
      }),
    /share of revenue/,
  );
  const ctx = { dao: DAO, payoutsFactory: FACTORY };
  assert.deepEqual(describeDecision(draft, ctx), {
    kind: "payouts",
    title: draft.title,
    lines: draft.lines,
  });
  assert.equal(
    describeDecision(draft, { dao: DAO }).kind,
    "batch",
    "with no factory known, it is only a list of steps",
  );
});

test("a payout from the treasury approves exactly what it declares", () => {
  const draft = declarePayoutDecision({
    dao: DAO,
    payouts: MODULE,
    currency: USDC,
    amount: 80_000_000n,
    decimals: 6,
    symbol: "USDC",
  });
  assert.equal(draft.title, "Pay holders 80 USDC from the treasury");
  assert.equal(draft.to, DAO, "the DAO runs its own batch");
  const ctx = {
    dao: DAO,
    currency: USDC,
    currencyDecimals: 6,
    currencySymbol: "USDC",
  };
  assert.equal(describeDecision(draft, ctx).title, draft.title);
  const mismatched = declarePayoutDecision({
    dao: DAO,
    payouts: MODULE,
    currency: USDC,
    amount: 1n,
    decimals: 6,
    symbol: "USDC",
  });
  // Approving one module and declaring on another is not described as a payout.
  const tampered = {
    to: DAO,
    data: mismatched.data.replace(MODULE.slice(2), FACTORY.slice(2)),
  };
  assert.notEqual(describeDecision(tampered, ctx).kind, "payouts");
});

test("a DAO's payouts are read with what is waiting and what the wallet can collect", async () => {
  const answers = {
    [`${DAO}:${encodeCall0(PAYOUTS_SIGNATURES.daoPayouts)}`]: words(
      BigInt(MODULE),
    ),
    [`${MODULE}:${encodeCall0(PAYOUTS_SIGNATURES.currency)}`]: words(
      BigInt(USDC),
    ),
    [`${MODULE}:${encodeCall0(PAYOUTS_SIGNATURES.splitBps)}`]: words(5_000),
    [`${MODULE}:${encodeCall0(PAYOUTS_SIGNATURES.pendingSplitBps)}`]:
      words(7_000),
    [`${MODULE}:${encodeCall0(PAYOUTS_SIGNATURES.splitAnnouncedAt)}`]:
      words(1_000),
    [`${MODULE}:${encodeCall0(PAYOUTS_SIGNATURES.reserved)}`]: words(40),
    [`${USDC}:${encodeFunctionData("balanceOf(address)", ["address"], [MODULE])}`]:
      words(100),
    [`${MODULE}:${encodeFunctionData(PAYOUTS_SIGNATURES.owed, ["address"], [ME])}`]:
      words(15),
  };
  const chain = {
    call: async (to, data) => {
      const answer = answers[`${to}:${data}`];
      if (!answer) throw new Error(`unexpected ${to} ${data}`);
      return answer;
    },
  };
  assert.deepEqual(await readPayouts(chain, DAO, ME), {
    module: MODULE,
    currency: USDC,
    splitBps: 5_000,
    pending: { splitBps: 7_000, from: 1_000 + SPLIT_NOTICE },
    waiting: 60n,
    owed: 15n,
  });
  const none = { call: async () => words(0) };
  assert.equal(await readPayouts(none, DAO, ME), null);
  const old = {
    call: async () => {
      throw new Error("execution reverted");
    },
  };
  assert.equal(await readPayouts(old, DAO, ME), null);
  const down = {
    call: async () => {
      throw new Error("fetch failed");
    },
  };
  await assert.rejects(readPayouts(down, DAO, ME), /fetch failed/);
});
