import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBindAuctionCall,
  buildFundAuctionCall,
  buildGraduationCall,
  buildOnTokensReceivedCall,
  buildSetHookAuctionCall,
  buildWithdrawStuckReserveCall,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  encodeExecuteGraduation,
  encodeParameters,
  SELECTOR_ERC20_BALANCE_OF,
  SELECTOR_ERC20_TRANSFER,
  SELECTOR_EXECUTE_GRADUATION,
  SELECTOR_ON_TOKENS_RECEIVED,
  selectorOf,
  ZERO_ADDRESS,
} from "./evmCalls.ts";

// This is the auction/graduation subset of the desktop app's evmCalls suite
// (the bid/exit/claim and token-deploy vectors live with bid-tx.test.mjs and
// mint-tx tests on the web). The CCA factory, config-data and executor-deploy
// vectors are bound in auctionFlow.test.mjs and graduationArtifact.test.mjs.
//
// Golden values: `cast sig` / `cast calldata` output, not derived by the code
// under test — ERC-20 transfer/balanceOf are the standard selectors, and
// executeGraduation(address) was generated with `cast sig`.

const EXECUTOR = "0xcccccccccccccccccccccccccccccccccccccccc";
const AUCTION = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0x1111111111111111111111111111111111111111";
const HOLDER = "0x2222222222222222222222222222222222222222";

const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const CAST_EXECUTE_GRADUATION = `0x69d4d0f1${word(AUCTION)}`;

test("selectors match cast sig", () => {
  assert.equal(SELECTOR_EXECUTE_GRADUATION, "0x69d4d0f1");
  assert.equal(SELECTOR_ERC20_TRANSFER, "0xa9059cbb");
  assert.equal(SELECTOR_ERC20_BALANCE_OF, "0x70a08231");
  // selectorOf is the seam every constant above is derived from: pin it
  // directly so a broken keccak cannot pass by agreeing with itself.
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
});

test("executeGraduation encoding matches the cast vector", () => {
  assert.equal(encodeExecuteGraduation(AUCTION), CAST_EXECUTE_GRADUATION);
});

test("ERC-20 transfer and balanceOf are selector plus padded words", () => {
  assert.equal(
    encodeErc20Transfer(HOLDER, 5n),
    `0xa9059cbb${word(HOLDER)}${word("0x5")}`,
  );
  assert.equal(encodeErc20BalanceOf(HOLDER), `0x70a08231${word(HOLDER)}`);
});

test("onTokensReceived takes no arguments: its calldata is exactly the selector", () => {
  const call = buildOnTokensReceivedCall(AUCTION);
  assert.equal(call.data, SELECTOR_ON_TOKENS_RECEIVED);
  assert.equal(call.data.length, 10);
});

test("every builder targets the right contract with zero native value", () => {
  assert.deepEqual(buildGraduationCall(EXECUTOR, AUCTION), {
    to: EXECUTOR,
    data: CAST_EXECUTE_GRADUATION,
    value: "0x0",
  });
  // Funding moves the whole supply from the wallet to the AUCTION, via the token.
  assert.deepEqual(buildFundAuctionCall(TOKEN, AUCTION, 7n), {
    to: TOKEN,
    data: encodeErc20Transfer(AUCTION, 7n),
    value: "0x0",
  });
  assert.equal(buildOnTokensReceivedCall(AUCTION).to, AUCTION);
  assert.equal(buildBindAuctionCall(EXECUTOR, AUCTION).to, EXECUTOR);
  assert.equal(buildSetHookAuctionCall(HOLDER, AUCTION).to, HOLDER);
  assert.equal(buildWithdrawStuckReserveCall(EXECUTOR, AUCTION).to, EXECUTOR);
  for (const call of [
    buildBindAuctionCall(EXECUTOR, AUCTION),
    buildSetHookAuctionCall(HOLDER, AUCTION),
    buildWithdrawStuckReserveCall(EXECUTOR, AUCTION),
  ]) {
    assert.equal(call.value, "0x0");
    // selector + one address word
    assert.equal(call.data.length, 2 + 8 + 64);
    assert.ok(call.data.endsWith(word(AUCTION)));
  }
});

test("bind and hook-bind and withdraw are three distinct calls", () => {
  const selectors = new Set(
    [
      buildBindAuctionCall(EXECUTOR, AUCTION),
      buildSetHookAuctionCall(EXECUTOR, AUCTION),
      buildWithdrawStuckReserveCall(EXECUTOR, AUCTION),
      buildGraduationCall(EXECUTOR, AUCTION),
    ].map((call) => call.data.slice(0, 10)),
  );
  assert.equal(selectors.size, 4, "no two builders may share a selector");
});

test("encoder rejects malformed inputs instead of emitting bad bytes", () => {
  const cases = [
    ["bad address", () => encodeErc20BalanceOf("0x1234"), /invalid address/],
    [
      "uint256 overflow",
      () => encodeErc20Transfer(HOLDER, 1n << 256n),
      /uint256 out of range/,
    ],
    [
      "negative amount",
      () => encodeErc20Transfer(HOLDER, -1n),
      /uint256 out of range/,
    ],
    [
      "bytes32 miswidth",
      () => encodeParameters(["bytes32"], ["0x1234"]),
      /bytes32 must be 32 bytes/,
    ],
    [
      "fewer values than types",
      () => encodeParameters(["address", "uint256"], [HOLDER]),
      /./,
    ],
    [
      "more values than types",
      () => encodeParameters(["address"], [HOLDER, 1n]),
      /./,
    ],
  ];
  for (const [label, fn, re] of cases) {
    assert.throws(fn, re, `expected rejection: ${label}`);
  }
  assert.equal(ZERO_ADDRESS.length, 42);
});
