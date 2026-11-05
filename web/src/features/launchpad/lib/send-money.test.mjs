import assert from "node:assert/strict";
import test from "node:test";

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";

import { moneyInput, moneyText, sendMoneyPlan } from "./send-money.ts";

const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const FROM = `0x${"aa".repeat(20)}`;
const TO = `0x${"bb".repeat(20)}`;
const usdc = { token: USDC, symbol: "USDC", decimals: 6, balance: 12_500_000n };
const eth = {
  token: null,
  symbol: "ETH",
  decimals: 18,
  balance: 3n * 10n ** 15n,
};

test("a token is sent with one transfer to the address typed, and the sentence says so", () => {
  const plan = sendMoneyPlan({
    held: usdc,
    amountText: "4.5",
    to: TO.toUpperCase().replace("0X", "0x"),
    from: FROM,
  });
  assert.deepEqual(plan.call, {
    to: USDC,
    data: encodeFunctionData(
      "transfer(address,uint256)",
      ["address", "uint256"],
      [TO, 4_500_000n],
    ),
  });
  assert.equal(plan.amount, 4_500_000n);
  assert.equal(plan.summary, `Send 4.5 USDC to ${TO}`);
});

test("ETH is sent as plain value, and all of it can be sent", () => {
  const all = moneyText(eth);
  assert.equal(all, "0.003");
  const plan = sendMoneyPlan({
    held: eth,
    amountText: all,
    to: TO,
    from: FROM,
  });
  assert.deepEqual(plan.call, {
    to: TO,
    data: "0x",
    value: `0x${eth.balance.toString(16)}`,
  });
});

test("what cannot be sent is said before anything is asked", () => {
  const problem = (over) =>
    sendMoneyPlan({ held: usdc, amountText: "1", to: TO, from: FROM, ...over })
      .problem;
  assert.match(problem({ to: "0x123" }), /full account address/);
  assert.match(problem({ to: `0x${"0".repeat(40)}` }), /full account address/);
  assert.match(problem({ to: FROM }), /own address/);
  assert.match(problem({ amountText: "0" }), /amount above zero/);
  assert.match(problem({ amountText: "12.6" }), /holds 12.5 USDC/);
  assert.match(
    problem({ amountText: "1.0000001" }),
    /at most 6 decimal places/,
  );
  assert.match(problem({ amountText: "lots" }), /number/);
  assert.equal(
    sendMoneyPlan({ held: usdc, amountText: "12.5", to: TO, from: FROM })
      .amount,
    12_500_000n,
  );
});

test("all of a large amount fills in without separators, and sends", () => {
  const big = { ...usdc, balance: 1_234_567_891n };
  assert.equal(moneyText(big), "1,234.567891");
  assert.equal(moneyInput(big), "1234.567891");
  assert.equal(
    sendMoneyPlan({
      held: big,
      amountText: moneyInput(big),
      to: TO,
      from: FROM,
    }).amount,
    big.balance,
  );
});
