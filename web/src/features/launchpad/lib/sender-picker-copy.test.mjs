import assert from "node:assert/strict";
import { test } from "node:test";

import {
  passkeyAccountLine,
  passkeyChoiceLabel,
} from "./sender-picker-copy.ts";

test("a passkey account on a real-money network never says its fees are covered on the test network", () => {
  // Base (8453) is the mainnet preset a VITE_ENABLE_MAINNET build can point the sponsored account at.
  assert.equal(
    passkeyChoiceLabel(8453),
    "Your passkey account (fees are covered on Base)",
  );
  assert.doesNotMatch(passkeyAccountLine("0xab…cd", 8453), /test network/);
  assert.match(
    passkeyAccountLine("0xab…cd", 8453),
    /Fees are covered on Base\./,
  );
});

test("on a test chain it says the test network, in words rather than a chain number", () => {
  assert.equal(
    passkeyChoiceLabel(11155111),
    "Your passkey account (fees are covered on the test network)",
  );
  const line = passkeyAccountLine("0xab…cd", 84532);
  assert.doesNotMatch(line, /chain \d|84532|Gas/);
  assert.match(line, /Fees are covered on the test network\./);
});

test("with no sponsored chain configured it promises nothing", () => {
  assert.equal(passkeyChoiceLabel(0), "Your passkey account");
  assert.doesNotMatch(passkeyAccountLine("0xab…cd", 0), /covered/);
});
