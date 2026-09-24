import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBidCalls,
  buildClaimTokensBatchCall,
  buildClaimTokensCall,
  buildExitBidCall,
  buildExitPartiallyFilledBidCall,
  buildGraduationCall,
  buildTokenDeployCalls,
  bidPlanWithDefaultHint,
  CANONICAL_TRANSFER_VALIDATOR,
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  encodeClaimTokens,
  encodeClaimTokensBatch,
  encodeDeployToken,
  encodeErc20Approve,
  encodeExecuteGraduation,
  encodeExitBid,
  encodeExitPartiallyFilledBid,
  encodeParameters,
  encodePermit2Approve,
  encodeSetRulesetOfCollection,
  encodeSetTransferValidator,
  encodeSubmitBid,
  PERMIT2_ADDRESS,
  SELECTOR_CLAIM_TOKENS,
  SELECTOR_CLAIM_TOKENS_BATCH,
  SELECTOR_DEPLOY_TOKEN,
  SELECTOR_ERC20_APPROVE,
  SELECTOR_EXECUTE_GRADUATION,
  SELECTOR_EXIT_BID,
  SELECTOR_EXIT_PARTIALLY_FILLED_BID,
  SELECTOR_PERMIT2_APPROVE,
  SELECTOR_SET_RULESET_OF_COLLECTION,
  SELECTOR_SET_TRANSFER_VALIDATOR,
  SELECTOR_SUBMIT_BID,
  selectorOf,
  ZERO_ADDRESS,
} from "./evmCalls.ts";

// ---------------------------------------------------------------------------
// Golden vectors. Sources:
// - web fixtures: `web/src/features/launchpad/lib/bid-tx.test.mjs` (generated
//   with `cast calldata`; do not hand-edit hex).
// - Solidity mirror: `contracts/test/BidCalldata.t.sol` carries the same
//   submitBid/exitBid/claimTokens/claimTokensBatch hex.
// - CLI mirror: `crates/buzz-cli/src/commands/launchpad_compose.rs` tests.
// - Fresh `cast calldata` / `cast abi-encode` output for the vectors web does
//   not cover (exitPartiallyFilledBid, ERC-20 approve, TokenMaster deploy,
//   validator wiring, graduation) — the exact commands are noted per vector.
// ---------------------------------------------------------------------------

// web bid-tx.test.mjs CAST_SUBMIT_EMPTY == BidCalldata.t.sol
// test_submitBid_encodes_to_the_composers_bytes_empty_hook:
// submitBid(1e21, 5e10, 0x1111.., 2^32+1, 0x)
const CAST_SUBMIT_EMPTY =
  "0x" +
  "a52c872800000000000000000000000000000000000000000000003635c9adc5" +
  "dea000000000000000000000000000000000000000000000000000000000000b" +
  "a43b740000000000000000000000000011111111111111111111111111111111" +
  "1111111100000000000000000000000000000000000000000000000000000001" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "000000a000000000000000000000000000000000000000000000000000000000" +
  "00000000";

// web bid-tx.test.mjs CAST_SUBMIT_HOOK == BidCalldata.t.sol
// test_submitBid_encodes_to_the_composers_bytes_with_hook_data:
// submitBid(2e21, 5e10, 0x1111.., 2^32+1, 0x1234) — dynamic tail padding.
const CAST_SUBMIT_HOOK =
  "0x" +
  "a52c872800000000000000000000000000000000000000000000006c6b935b8b" +
  "bd4000000000000000000000000000000000000000000000000000000000000b" +
  "a43b740000000000000000000000000011111111111111111111111111111111" +
  "1111111100000000000000000000000000000000000000000000000000000001" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "000000a000000000000000000000000000000000000000000000000000000000" +
  "0000000212340000000000000000000000000000000000000000000000000000" +
  "00000000";

// web bid-tx.test.mjs CAST_EXIT == BidCalldata.t.sol test_exitBid:
// exitBid(42)
const CAST_EXIT =
  "0x" +
  "8e4deb1700000000000000000000000000000000000000000000000000000000" +
  "0000002a";

// `cast calldata "exitPartiallyFilledBid(uint256,uint64,uint64)" 42 123 456`
// (signature from the vendored IContinuousClearingAuction, which additionally
// pins that exitBid is for fully filled bids only)
const CAST_EXIT_PARTIALLY_FILLED =
  "0x" +
  "36dec5f200000000000000000000000000000000000000000000000000000000" +
  "0000002a00000000000000000000000000000000000000000000000000000000" +
  "0000007b00000000000000000000000000000000000000000000000000000000" +
  "000001c8";

// launchpad_compose.rs `exit_and_claim_selectors` ==
// BidCalldata.t.sol test_claimTokens: claimTokens(7)
const CAST_CLAIM =
  "0x" +
  "46e04a2f00000000000000000000000000000000000000000000000000000000" +
  "00000007";

// web bid-tx.test.mjs CAST_CLAIM_BATCH == BidCalldata.t.sol test_claimTokensBatch:
// claimTokensBatch(0x2222.., [1,2,3])
const CAST_CLAIM_BATCH =
  "0x" +
  "b8f163d600000000000000000000000022222222222222222222222222222222" +
  "2222222200000000000000000000000000000000000000000000000000000000" +
  "0000004000000000000000000000000000000000000000000000000000000000" +
  "0000000300000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "0000000200000000000000000000000000000000000000000000000000000000" +
  "00000003";

// web bid-tx.test.mjs CAST_PERMIT2_APPROVE:
// approve(0x3333.., 0x4444.., 1234567890123456789, 4102444800) on Permit2
const CAST_PERMIT2_APPROVE =
  "0x" +
  "87517c4500000000000000000000000033333333333333333333333333333333" +
  "3333333300000000000000000000000044444444444444444444444444444444" +
  "44444444000000000000000000000000000000000000000000000000112210f4" +
  "7de9811500000000000000000000000000000000000000000000000000000000" +
  "f4865700";

// `cast calldata "approve(address,uint256)" 0x000000000022D473030F116dDEE9F6B43aC78BA3 50000000000`
// — the underlying ERC-20 -> Permit2 allowance the web flow omits
const CAST_ERC20_APPROVE_PERMIT2 =
  "0x" +
  "095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b4" +
  "3ac78ba30000000000000000000000000000000000000000000000000000000b" +
  "a43b7400";

// `cast calldata "setTransferValidator(address)" 0x721C008fdff27BF06E7E123956E2Fe03B63342e3`
const CAST_SET_TRANSFER_VALIDATOR =
  "0x" +
  "a9fc664e000000000000000000000000721c008fdff27bf06e7e123956e2fe03" +
  "b63342e3";

// `cast calldata "setRulesetOfCollection(address,uint8,address,uint8,uint16)"
//   0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 0x0000000000000000000000000000000000000000 0 0`
const CAST_SET_RULESET_OF_COLLECTION =
  "0x" +
  "bc8aa284000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
  "aaaaaaaa00000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000";

// `cast calldata "executeGraduation(address)" 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`
const CAST_EXECUTE_GRADUATION =
  "0x" +
  "69d4d0f1000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" +
  "bbbbbbbb";

// `cast abi-encode "f((address,uint256,...,(uint16,...),(uint16,uint16),(uint16),uint256))" (...)`
// with the DeployAppToken.s.sol defaults: treasury recipient, 1e24 supply,
// spread 100, buy fee 200, sell fee 200, creator share 5000. This is the
// `encodedInitializationArgs` bytes blob nested inside CAST_DEPLOY_TOKEN.
const CAST_STANDARD_POOL_INIT_ARGS =
  "0x" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "00000000000000000000000000000000000000000000d3c21bcecceda1000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000270f" +
  "0000000000000000000000000000000000000000000000000000000000002710" +
  "0000000000000000000000000000000000000000000000000000000000002710" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000270f" +
  "0000000000000000000000000000000000000000000000000000000000002710" +
  "0000000000000000000000000000000000000000000000000000000000002710" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000064" +
  "00000000000000000000000000000000000000000000000000000000000000c8" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000064" +
  "00000000000000000000000000000000000000000000000000000000000000c8" +
  "0000000000000000000000000000000000000000000000000000000000001388" +
  "0000000000000000000000000000000000000000000000000000000000000000";

// `cast calldata "deployToken((address,bytes32,address,bool,bool,(string,
// string,uint8,address,address,uint256,bytes,address,bool,address,uint256),
// uint16),(uint256,bytes32,bytes32))" "(...)" "(0,0x0,0x0)"` with the
// DeployAppToken.s.sol defaults (factory 0x000000c5.., salt 1, token
// 0xaaaa.., "Nebula"/"NEB", treasury 0x1111.., 0.1 ether deposit, zero
// default TV, maxInfraFee 250, empty signature).
const CAST_DEPLOY_TOKEN =
  "0x" +
  "a29f4a5600000000000000000000000000000000000000000000000000000000" +
  "0000008000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000000c5f2df717f497beacce161f8b0" +
  "42310d1700000000000000000000000000000000000000000000000000000000" +
  "00000001000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
  "aaaaaaaa00000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000e000000000000000000000000000000000000000000000000000000000" +
  "000000fa00000000000000000000000000000000000000000000000000000000" +
  "0000016000000000000000000000000000000000000000000000000000000000" +
  "000001a000000000000000000000000000000000000000000000000000000000" +
  "0000001200000000000000000000000011111111111111111111111111111111" +
  "1111111100000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000001634578" +
  "5d8a000000000000000000000000000000000000000000000000000000000000" +
  "000001e000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000064e6562756c6100000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000034e454200000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000038000000000000000000000000011111111111111111111111111111111" +
  "1111111100000000000000000000000000000000000000000000d3c21bcecced" +
  "a100000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000270f00000000000000000000000000000000000000000000000000000000" +
  "0000271000000000000000000000000000000000000000000000000000000000" +
  "0000271000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000270f00000000000000000000000000000000000000000000000000000000" +
  "0000271000000000000000000000000000000000000000000000000000000000" +
  "0000271000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000006400000000000000000000000000000000000000000000000000000000" +
  "000000c80000000000000000000000000000000000000000000000000de0b6b3" +
  "a76400000000000000000000000000000000000000000000000000000de0b6b3" +
  "a764000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000006400000000000000000000000000000000000000000000000000000000" +
  "000000c800000000000000000000000000000000000000000000000000000000" +
  "0000138800000000000000000000000000000000000000000000000000000000" +
  "00000000";

const BIDDER = "0x1111111111111111111111111111111111111111";
const AUCTION = "0x5555555555555555555555555555555555555555";
const CURRENCY = "0x3333333333333333333333333333333333333333";

const emptyHookPlan = bidPlanWithDefaultHint(
  {
    maxPriceQ96: 10n ** 21n,
    amount: 50_000_000_000n,
    owner: BIDDER,
    hookData: "0x",
  },
  4_294_967_297n,
);

const hookPlan = bidPlanWithDefaultHint(
  {
    maxPriceQ96: 2n * 10n ** 21n,
    amount: 50_000_000_000n,
    owner: BIDDER,
    hookData: "0x1234",
  },
  4_294_967_297n,
);

// The TokenDeployCallsParams whose encoding CAST_DEPLOY_TOKEN was generated
// from (DeployAppToken.s.sol defaults).
const deployParams = {
  name: "Nebula",
  symbol: "NEB",
  treasury: BIDDER,
  tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  salt: 1n,
  initialSupplyAmount: 1_000_000n * 10n ** 18n,
  pairedDepositWei: 10n ** 17n, // 0.1 ether
  spreadBps: 100,
  buyFeeBps: 200,
  sellFeeBps: 200,
  defaultTransferValidator: ZERO_ADDRESS,
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test("derived selectors match the pinned signatures across all three mirrors", () => {
  // Values cross-checked with `cast sig '<signature>'`; the web/CLI pins live
  // in bid-tx.ts / launchpad_compose.rs, the Solidity ones in BidCalldata.t.sol
  // (keccak-derived) and the vendored tm-tokenmaster interfaces.
  const table = [
    [SELECTOR_SUBMIT_BID, "0xa52c8728", "web + CLI pin"],
    [SELECTOR_EXIT_BID, "0x8e4deb17", "web + CLI pin"],
    [SELECTOR_EXIT_PARTIALLY_FILLED_BID, "0x36dec5f2", "cast sig"],
    [SELECTOR_CLAIM_TOKENS, "0x46e04a2f", "web + CLI pin"],
    [SELECTOR_CLAIM_TOKENS_BATCH, "0xb8f163d6", "web + CLI pin"],
    [SELECTOR_PERMIT2_APPROVE, "0x87517c45", "web + CLI pin"],
    [SELECTOR_ERC20_APPROVE, "0x095ea7b3", "cast sig (standard ERC-20)"],
    [SELECTOR_SET_TRANSFER_VALIDATOR, "0xa9fc664e", "cast sig"],
    [SELECTOR_SET_RULESET_OF_COLLECTION, "0xbc8aa284", "cast sig"],
    [SELECTOR_DEPLOY_TOKEN, "0xa29f4a56", "cast sig (ITokenMasterRouter)"],
    [SELECTOR_EXECUTE_GRADUATION, "0x69d4d0f1", "cast sig"],
  ];
  for (const [got, want, source] of table) {
    assert.equal(got, want, `selector drifted from ${source}`);
  }
  // selectorOf is the production seam the constants above are derived from:
  // a broken keccak breaks every calldata vector below, so pin it directly too.
  assert.equal(
    selectorOf("submitBid(uint256,uint128,address,uint256,bytes)"),
    "0xa52c8728",
  );
});

// ---------------------------------------------------------------------------
// Bid / exit / claim encoders
// ---------------------------------------------------------------------------

test("submitBid encoding matches cast for empty hookData", () => {
  assert.equal(encodeSubmitBid(emptyHookPlan), CAST_SUBMIT_EMPTY);
});

test("submitBid encoding matches cast with non-empty hookData", () => {
  assert.equal(encodeSubmitBid(hookPlan), CAST_SUBMIT_HOOK);
});

test("exitBid encoding matches cast", () => {
  assert.equal(encodeExitBid(42n), CAST_EXIT);
});

test("exitPartiallyFilledBid encoding matches cast", () => {
  assert.equal(
    encodeExitPartiallyFilledBid(42n, 123n, 456n),
    CAST_EXIT_PARTIALLY_FILLED,
  );
});

test("claimTokens encoding matches the CLI/Solidity fixture", () => {
  assert.equal(encodeClaimTokens(7n), CAST_CLAIM);
});

test("claimTokensBatch encoding matches cast (owner, [1,2,3])", () => {
  assert.equal(
    encodeClaimTokensBatch("0x2222222222222222222222222222222222222222", [
      1n,
      2n,
      3n,
    ]),
    CAST_CLAIM_BATCH,
  );
});

test("claimTokensBatch rejects an empty batch", () => {
  assert.throws(() => encodeClaimTokensBatch(BIDDER, []));
});

test("Permit2 approve encoding matches cast", () => {
  assert.equal(
    encodePermit2Approve(
      "0x3333333333333333333333333333333333333333",
      "0x4444444444444444444444444444444444444444",
      1_234_567_890_123_456_789n,
      4_102_444_800n,
    ),
    CAST_PERMIT2_APPROVE,
  );
});

test("underlying ERC-20 approve encoding matches cast", () => {
  assert.equal(
    encodeErc20Approve(PERMIT2_ADDRESS, 50_000_000_000n),
    CAST_ERC20_APPROVE_PERMIT2,
  );
});

// ---------------------------------------------------------------------------
// buildBidCalls composition
// ---------------------------------------------------------------------------

test("buildBidCalls orders underlying approve -> Permit2 approve -> submitBid", () => {
  const calls = buildBidCalls({
    auction: AUCTION,
    currency: CURRENCY,
    plan: emptyHookPlan,
    needsUnderlyingAllowance: true,
    permit2Deadline: 4_102_444_800n,
  });
  assert.equal(calls.length, 3);
  // 1. underlying ERC-20 -> Permit2 (the step the web flow omits; without it
  // permit2TransferFrom reverts for a first-time bidder)
  assert.equal(calls[0].to, CURRENCY);
  assert.equal(calls[0].data, CAST_ERC20_APPROVE_PERMIT2);
  // 2. Permit2 -> auction spender allowance
  assert.equal(calls[1].to, PERMIT2_ADDRESS);
  assert.equal(
    calls[1].data,
    encodePermit2Approve(
      CURRENCY,
      AUCTION,
      emptyHookPlan.amount,
      4_102_444_800n,
    ),
  );
  // 3. the bid itself
  assert.equal(calls[2].to, AUCTION);
  assert.equal(calls[2].data, CAST_SUBMIT_EMPTY);
  for (const call of calls) assert.equal(call.value, "0x0");
});

test("buildBidCalls skips the underlying approve when the allowance exists", () => {
  const calls = buildBidCalls({
    auction: AUCTION,
    currency: CURRENCY,
    plan: emptyHookPlan,
    needsUnderlyingAllowance: false,
    permit2Deadline: 4_102_444_800n,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, PERMIT2_ADDRESS);
  assert.equal(calls[1].data, CAST_SUBMIT_EMPTY);
});

test("buildBidCalls on a native auction is a single call carrying the budget", () => {
  const calls = buildBidCalls({
    auction: AUCTION,
    currency: ZERO_ADDRESS,
    plan: emptyHookPlan,
    // ignored for native auctions: no token, no allowances
    needsUnderlyingAllowance: true,
    permit2Deadline: 0n,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, AUCTION);
  assert.equal(calls[0].data, CAST_SUBMIT_EMPTY);
  // the vendored CCA enforces msg.value == amount for native bids
  assert.equal(calls[0].value, "0xba43b7400");
});

test("buildBidCalls keeps the hook-data plan's exact bytes", () => {
  const calls = buildBidCalls({
    auction: AUCTION,
    currency: CURRENCY,
    plan: hookPlan,
    needsUnderlyingAllowance: true,
    permit2Deadline: 1n,
  });
  assert.equal(calls[2].data, CAST_SUBMIT_HOOK);
});

// ---------------------------------------------------------------------------
// Single-call builders
// ---------------------------------------------------------------------------

test("exit/claim/graduation builders wrap the encoders as zero-value calls", () => {
  assert.deepEqual(buildExitBidCall(AUCTION, 42n), {
    to: AUCTION,
    data: CAST_EXIT,
    value: "0x0",
  });
  assert.deepEqual(buildExitPartiallyFilledBidCall(AUCTION, 42n, 123n, 456n), {
    to: AUCTION,
    data: CAST_EXIT_PARTIALLY_FILLED,
    value: "0x0",
  });
  assert.deepEqual(buildClaimTokensCall(AUCTION, 7n), {
    to: AUCTION,
    data: CAST_CLAIM,
    value: "0x0",
  });
  assert.deepEqual(
    buildClaimTokensBatchCall(
      AUCTION,
      "0x2222222222222222222222222222222222222222",
      [1n, 2n, 3n],
    ),
    { to: AUCTION, data: CAST_CLAIM_BATCH, value: "0x0" },
  );
  assert.deepEqual(
    buildGraduationCall(
      "0xcccccccccccccccccccccccccccccccccccccccc",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    {
      to: "0xcccccccccccccccccccccccccccccccccccccccc",
      data: CAST_EXECUTE_GRADUATION,
      value: "0x0",
    },
  );
});

test("executeGraduation encoding matches cast", () => {
  assert.equal(
    encodeExecuteGraduation("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    CAST_EXECUTE_GRADUATION,
  );
});

// ---------------------------------------------------------------------------
// Token deploy (DeployAppToken.s.sol mirror)
// ---------------------------------------------------------------------------

test("deployToken encoding matches cast", () => {
  assert.equal(encodeDeployToken(deployParams), CAST_DEPLOY_TOKEN);
});

test("deployToken nests the exact StandardPool init-args blob", () => {
  // Independent inner vector from `cast abi-encode`; its presence at the tail
  // pins the nested encodedInitializationArgs even if outer offsets move.
  const got = encodeDeployToken(deployParams).slice(2);
  assert.ok(got.includes(CAST_STANDARD_POOL_INIT_ARGS.slice(2)));
  // and the outer vector embeds the very same blob (fixture self-consistency)
  assert.ok(
    CAST_DEPLOY_TOKEN.slice(2).includes(CAST_STANDARD_POOL_INIT_ARGS.slice(2)),
  );
});

test("buildTokenDeployCalls mirrors the script's broadcast sequence", () => {
  const calls = buildTokenDeployCalls(deployParams);
  assert.equal(calls.length, 3);
  // 1. router.deployToken{value: pairedDeposit} — deploys token + pool at
  //    tokenAddress and mints the initial supply to treasury
  assert.equal(calls[0].to, DEFAULT_TOKENMASTER_ROUTER);
  assert.equal(calls[0].data, CAST_DEPLOY_TOKEN);
  assert.equal(calls[0].value, "0x16345785d8a0000"); // 0.1 ether
  assert.ok(
    calls[0].data.includes(
      DEFAULT_STANDARD_POOL_FACTORY.slice(2).toLowerCase(),
    ),
  );
  // 2. token.setTransferValidator(realTV) — realTV resolves the zero default
  //    to the canonical validator, exactly like the script's `realTV`
  assert.equal(calls[1].to, deployParams.tokenAddress);
  assert.equal(calls[1].data, CAST_SET_TRANSFER_VALIDATOR);
  assert.equal(calls[1].value, "0x0");
  // 3. realTV.setRulesetOfCollection(token, 1, address(0), 0, 0) — Vanilla
  assert.equal(calls[2].to, CANONICAL_TRANSFER_VALIDATOR);
  assert.equal(calls[2].data, CAST_SET_RULESET_OF_COLLECTION);
  assert.equal(calls[2].value, "0x0");
});

test("buildTokenDeployCalls honors an explicit transfer validator", () => {
  const customTv = "0x9999999999999999999999999999999999999999";
  const calls = buildTokenDeployCalls({
    ...deployParams,
    defaultTransferValidator: customTv,
    router: "0xdddddddddddddddddddddddddddddddddddddddd",
    factory: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  });
  assert.equal(calls[0].to, "0xdddddddddddddddddddddddddddddddddddddddd");
  assert.equal(
    calls[0].data,
    encodeDeployToken({
      ...deployParams,
      defaultTransferValidator: customTv,
      router: "0xdddddddddddddddddddddddddddddddddddddddd",
      factory: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }),
  );
  // the poolParams.defaultTransferValidator stays the caller's value while the
  // wiring goes to the resolved validator (the script's exact split)
  assert.ok(calls[0].data.includes(customTv.slice(2).toLowerCase()));
  assert.equal(calls[1].to, deployParams.tokenAddress);
  assert.ok(calls[1].data.endsWith(customTv.slice(2).toLowerCase()));
  assert.equal(calls[2].to, customTv);
});

test("setTransferValidator and setRulesetOfCollection match cast", () => {
  assert.equal(
    encodeSetTransferValidator(CANONICAL_TRANSFER_VALIDATOR),
    CAST_SET_TRANSFER_VALIDATOR,
  );
  assert.equal(
    encodeSetRulesetOfCollection(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      1n,
      ZERO_ADDRESS,
      0n,
      0n,
    ),
    CAST_SET_RULESET_OF_COLLECTION,
  );
});

// ---------------------------------------------------------------------------
// Rejection paths — a wrong-width or malformed input must throw, not encode
// ---------------------------------------------------------------------------

test("encoder rejects malformed inputs instead of emitting bad bytes", () => {
  const cases = [
    ["bad address", () => encodeErc20Approve("0x1234", 1n), /invalid address/],
    [
      "non-hex hookData",
      () => encodeSubmitBid({ ...emptyHookPlan, hookData: "zz" }),
      /hex/,
    ],
    [
      "uint128 bid amount overflow",
      () => encodeSubmitBid({ ...emptyHookPlan, amount: 1n << 128n }),
      /uint128 out of range/,
    ],
    [
      "uint64 checkpoint block overflow",
      () => encodeExitPartiallyFilledBid(1n, 1n << 64n, 1n),
      /uint64 out of range/,
    ],
    [
      "uint8 ruleset id overflow",
      () => encodeSetRulesetOfCollection(BIDDER, 256n, ZERO_ADDRESS, 0n, 0n),
      /uint8 out of range/,
    ],
    [
      "bytes32 salt miswidth",
      () => encodeParameters(["bytes32"], ["0x1234"]),
      /bytes32 must be 32 bytes/,
    ],
    [
      "negative Permit2 amount",
      () => encodePermit2Approve(CURRENCY, AUCTION, -1n, 1n),
      /uint160 out of range/,
    ],
  ];
  for (const [label, fn, re] of cases) {
    assert.throws(fn, re, `expected rejection: ${label}`);
  }
});

test("bidPlanWithDefaultHint fills the floor hint like the web helper", () => {
  const floor = 1_000_000_000_000_000_000n;
  assert.equal(
    bidPlanWithDefaultHint(emptyHookPlan, floor).prevTickPriceQ96,
    floor,
  );
});
