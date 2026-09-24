import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBidViewCall,
  buildCheckpointTxCall,
  buildCheckpointViewCall,
  buildClaimExecution,
  buildExitCallForPlan,
  buildExitExecution,
  buildNoArgViewCall,
  completedExitSteps,
  decodeBidView,
  decodeCheckpointView,
  deriveBidActions,
  deriveClaimPlan,
  deriveExitPlan,
  EXIT_STEP_LABELS,
  fetchCheckpointWalk,
  initialExitFlowState,
  isCheckpointMaterialized,
  MAX_CHECKPOINT_BLOCK,
  remainingExitSteps,
  resumeExitFromState,
  exitFlowReducer,
  runExitFlow,
  SIGNATURE_CHECKPOINTS,
  SIGNATURE_CHECKPOINT,
  SIGNATURE_CLAIM_BLOCK,
  SIGNATURE_CLEARING_PRICE,
  SIGNATURE_END_BLOCK,
  SIGNATURE_IS_GRADUATED,
  SIGNATURE_LAST_CHECKPOINTED_BLOCK,
  SIGNATURE_BIDS,
} from "./exitHooks.ts";
import { selectorOf } from "./lib/evmCalls.ts";
import { SELECTOR_IS_GRADUATED } from "./lib/chainRpc.ts";

// ---------------------------------------------------------------------------
// Golden vectors. Sources (foundry `cast` 1.4.3-stable):
// - `cast sig '<signature>'` for every selector below.
// - `cast calldata '<signature>' <args…>` for the argument blocks.
// - `cast abi-encode 'x((uint64,uint24,uint64,uint256,address,uint256,uint256))'`
//   / `cast abi-encode 'x((uint256,uint256,uint256,uint24,uint64,uint64))'` for
//   the struct-return word layouts (a static struct return encodes exactly as
//   its tuple). Struct field orders are the pinned interfaces:
//   libraries/BidLib.sol:6-14 and libraries/CheckpointLib.sol:7-14.
// - `lib/evmCalls.test.mjs` carries the `cast` pins for the exit/claim CALL
//   vectors reused in the execution-mapping section.
// ---------------------------------------------------------------------------

// `cast calldata 'bids(uint256)' 42`
const CAST_BIDS_42 =
  "0x4423c5f1000000000000000000000000000000000000000000000000000000000000002a";

// `cast calldata 'checkpoints(uint64)' 123`
const CAST_CHECKPOINTS_123 =
  "0xb122db60000000000000000000000000000000000000000000000000000000000000007b";

// `cast abi-encode 'x((uint64,uint24,uint64,uint256,address,uint256,uint256))' '(1,2,3,42,0x1111111111111111111111111111111111111111,5,6)'`
const CAST_ABI_BID =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "000000000000000000000000000000000000000000000000000000000000002a" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000005" +
  "0000000000000000000000000000000000000000000000000000000000000006";

// `cast abi-encode 'x((uint256,uint256,uint256,uint24,uint64,uint64))' '(7,8,9,10,11,18446744073709551615)'`
const CAST_ABI_CHECKPOINT =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "0000000000000000000000000000000000000000000000000000000000000008" +
  "0000000000000000000000000000000000000000000000000000000000000009" +
  "000000000000000000000000000000000000000000000000000000000000000a" +
  "000000000000000000000000000000000000000000000000000000000000000b" +
  "000000000000000000000000000000000000000000000000ffffffffffffffff";

// `cast sig` pins (foundry 1.4.3-stable).
const CAST_SIGS = [
  [SIGNATURE_BIDS, "0x4423c5f1"],
  [SIGNATURE_CHECKPOINTS, "0xb122db60"],
  [SIGNATURE_IS_GRADUATED, "0x9e5f2602"],
  [SIGNATURE_CLEARING_PRICE, "0x32a0f2d7"],
  [SIGNATURE_END_BLOCK, "0x083c6323"],
  [SIGNATURE_CLAIM_BLOCK, "0x37dfbc4b"],
  [SIGNATURE_LAST_CHECKPOINTED_BLOCK, "0x11ea09d0"],
  [SIGNATURE_CHECKPOINT, "0xc2c4c5c1"],
];

// Exit/claim call vectors, pinned with `cast calldata` in
// `lib/evmCalls.test.mjs` (same commands):
// `cast calldata "exitBid(uint256)" 42`
const CAST_EXIT =
  "0x8e4deb17000000000000000000000000000000000000000000000000000000000000002a";
// `cast calldata "exitPartiallyFilledBid(uint256,uint64,uint64)" 42 123 456`
const CAST_EXIT_PARTIALLY_FILLED =
  "0x" +
  "36dec5f200000000000000000000000000000000000000000000000000000000" +
  "0000002a00000000000000000000000000000000000000000000000000000000" +
  "0000007b00000000000000000000000000000000000000000000000000000000" +
  "000001c8";
// `cast calldata "claimTokens(uint256)" 7`
const CAST_CLAIM =
  "0x46e04a2f0000000000000000000000000000000000000000000000000000000000000007";
// `cast calldata "claimTokensBatch(address,uint256[])" 0x2222…2222 '[1,2,3]'`
const CAST_CLAIM_BATCH =
  "0x" +
  "b8f163d600000000000000000000000022222222222222222222222222222222" +
  "2222222200000000000000000000000000000000000000000000000000000000" +
  "0000004000000000000000000000000000000000000000000000000000000000" +
  "0000000300000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "0000000200000000000000000000000000000000000000000000000000000000" +
  "00000003";

const AUCTION = "0x5555555555555555555555555555555555555555";
const OWNER = "0x2222222222222222222222222222222222222222";
const RPC_URL = "http://rpc.test";
const CHAIN_ID = 8453;

// ---------------------------------------------------------------------------
// View calldata builders — golden vectors
// ---------------------------------------------------------------------------

test("view selectors match `cast sig`", () => {
  for (const [signature, expected] of CAST_SIGS) {
    assert.equal(selectorOf(signature), expected, signature);
  }
});

test("isGraduated() selector is the chainRpc.ts pinned 0x9e5f2602", () => {
  assert.equal(selectorOf(SIGNATURE_IS_GRADUATED), SELECTOR_IS_GRADUATED);
});

test("buildBidViewCall matches `cast calldata 'bids(uint256)' 42`", () => {
  const call = buildBidViewCall(AUCTION, 42n);
  assert.equal(call.data, CAST_BIDS_42);
  assert.equal(call.to, AUCTION);
  assert.equal(call.value, "0x0");
});

test("buildCheckpointViewCall matches `cast calldata 'checkpoints(uint64)' 123`", () => {
  const call = buildCheckpointViewCall(AUCTION, 123n);
  assert.equal(call.data, CAST_CHECKPOINTS_123);
  assert.equal(call.to, AUCTION);
});

test("buildCheckpointTxCall is the bare checkpoint() selector", () => {
  assert.equal(buildCheckpointTxCall(AUCTION).data, "0xc2c4c5c1");
  assert.equal(
    buildNoArgViewCall(AUCTION, SIGNATURE_IS_GRADUATED).data,
    "0x9e5f2602",
  );
});

// ---------------------------------------------------------------------------
// Return decoders — golden vectors
// ---------------------------------------------------------------------------

test("decodeBidView matches the `cast abi-encode` Bid word layout", () => {
  assert.deepEqual(decodeBidView(CAST_ABI_BID), {
    startBlock: 1n,
    startCumulativeMps: 2n,
    exitedBlock: 3n,
    maxPrice: 42n,
    owner: "0x1111111111111111111111111111111111111111",
    amountQ96: 5n,
    tokensFilled: 6n,
  });
});

test("decodeCheckpointView matches the `cast abi-encode` Checkpoint word layout", () => {
  assert.deepEqual(decodeCheckpointView(123n, CAST_ABI_CHECKPOINT), {
    block: 123n,
    clearingPrice: 7n,
    currencyRaisedAtClearingPriceQ96X7: 8n,
    cumulativeMpsPerPrice: 9n,
    cumulativeMps: 10n,
    prev: 11n,
    next: MAX_CHECKPOINT_BLOCK,
  });
});

test("decoders reject wrong-size returns (no silent success)", () => {
  assert.throws(() => decodeBidView("0x"), /expected 7 ABI words/);
  assert.throws(
    () => decodeBidView(CAST_ABI_CHECKPOINT),
    /expected 7 ABI words/,
  );
  assert.throws(
    () => decodeCheckpointView(1n, CAST_ABI_BID),
    /expected 6 ABI words/,
  );
  assert.throws(() => decodeBidView("0xzz"), /expected 7 ABI words/);
});

test("isCheckpointMaterialized distinguishes empty slots from the tail", () => {
  // Unmaterialized key: `checkpoints(uint64)` returns the zero struct.
  const empty = decodeCheckpointView(5n, `0x${"0".repeat(64 * 6)}`);
  assert.equal(isCheckpointMaterialized(empty), false);
  const tail = decodeCheckpointView(5n, CAST_ABI_CHECKPOINT);
  assert.equal(isCheckpointMaterialized(tail), true);
});

// ---------------------------------------------------------------------------
// deriveBidActions — table over the input combination space
// ---------------------------------------------------------------------------

const TAIL_NEXT = MAX_CHECKPOINT_BLOCK;
const MAX_PRICE = 100n;

/** One checkpoint fixture; `prev`/`next` are checkpoint block numbers. */
function cp(block, clearingPrice, prev, next) {
  return {
    block,
    clearingPrice,
    currencyRaisedAtClearingPriceQ96X7: 0n,
    cumulativeMpsPerPrice: 0n,
    cumulativeMps: 0n,
    prev,
    next,
  };
}

function bid(overrides = {}) {
  return {
    startBlock: 10n,
    startCumulativeMps: 0n,
    exitedBlock: 0n,
    maxPrice: MAX_PRICE,
    owner: OWNER,
    amountQ96: 5n << 96n,
    tokensFilled: 0n,
    ...overrides,
  };
}

function auctionCtx(overrides = {}) {
  return {
    graduated: true,
    liveClearingPrice: 50n,
    endBlock: 1000n,
    claimBlock: 1100n,
    currentBlock: 500n,
    ...overrides,
  };
}

function input({ bidView, checkpoints, auction }) {
  return {
    bidId: 42n,
    bid: bidView ?? bid(),
    checkpoints,
    auction: auction ?? auctionCtx(),
  };
}

// Exit branches. Each case cites the contract branch it pins.
const EXIT_TABLE = [
  {
    name: "exited bids cannot exit again (BidAlreadyExited, :497/:523)",
    input: input({
      bidView: bid({ exitedBlock: 5n }),
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
    }),
    expect: { kind: "unavailable", reason: /already exited/ },
  },
  {
    name: "inconsistent walk: first checkpoint not at bid.startBlock",
    input: input({ checkpoints: [cp(9n, 50n, 0n, TAIL_NEXT)] }),
    expect: { kind: "unavailable", reason: /inconsistent/ },
  },
  {
    name: "inconsistent walk: start checkpoint at/above maxPrice (:366 forbids it)",
    input: input({ checkpoints: [cp(10n, MAX_PRICE, 0n, TAIL_NEXT)] }),
    expect: { kind: "unavailable", reason: /inconsistent/ },
  },
  {
    name: "inconsistent walk: non-monotonic clearing price (:586)",
    input: input({
      checkpoints: [
        cp(10n, 50n, 0n, 20n),
        cp(20n, MAX_PRICE, 10n, 30n),
        cp(30n, 40n, 20n, TAIL_NEXT),
      ],
    }),
    expect: { kind: "unavailable", reason: /inconsistent/ },
  },
  {
    name: "not graduated + over → exitBid full refund (:499-501)",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ graduated: false, currentBlock: 1000n }),
    }),
    expect: { kind: "exitBid" },
  },
  {
    name: "not graduated + live → nothing legal yet (:526-531)",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ graduated: false, currentBlock: 500n }),
    }),
    expect: { kind: "unavailable", reason: /auction ends/ },
  },
  {
    name: "outbid (== then >): partial exit with exact hints, early exit (:559-572)",
    input: input({
      checkpoints: [
        cp(10n, 90n, 0n, 20n),
        cp(20n, MAX_PRICE, 10n, 30n),
        cp(30n, 150n, 20n, TAIL_NEXT),
      ],
    }),
    expect: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 10n,
      outbidBlock: 30n,
    },
  },
  {
    name: "outbid (jump < to >): hints are lastBelow + first above",
    input: input({
      checkpoints: [
        cp(10n, 90n, 0n, 20n),
        cp(20n, 95n, 10n, 30n),
        cp(30n, 150n, 20n, TAIL_NEXT),
      ],
    }),
    expect: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 20n,
      outbidBlock: 30n,
    },
  },
  {
    name: "outbid at the bid's own start checkpoint block (the :550-551 shape)",
    input: input({
      checkpoints: [cp(10n, 90n, 0n, 20n), cp(20n, 150n, 10n, TAIL_NEXT)],
    }),
    expect: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 10n,
      outbidBlock: 20n,
    },
  },
  {
    name: "materialized outbid wins over a pending final checkpoint",
    input: input({
      checkpoints: [cp(10n, 90n, 0n, 20n), cp(20n, 150n, 10n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1000n }),
    }),
    expect: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 10n,
      outbidBlock: 20n,
    },
  },
  {
    name: "over + final checkpoint pending → checkpointThenExit",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1000n }),
    }),
    expect: { kind: "checkpointThenExit" },
  },
  {
    name: "live + price crossed only in clearingPrice() (forceIterate) → checkpointThenExit",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ liveClearingPrice: 150n, currentBlock: 500n }),
    }),
    expect: { kind: "checkpointThenExit" },
  },
  {
    name: "live + not outbid yet → unavailable (:503-504/:559 gate it)",
    input: input({ checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)] }),
    expect: { kind: "unavailable", reason: /auction end/ },
  },
  {
    name: "live + partially filled at == maxPrice but not outbid → unavailable",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, 20n), cp(20n, MAX_PRICE, 10n, TAIL_NEXT)],
      auction: auctionCtx({ liveClearingPrice: MAX_PRICE }),
    }),
    expect: { kind: "unavailable", reason: /auction end/ },
  },
  {
    name: "over + final materialized + maxPrice > final → exitBid (:504)",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, 1000n), cp(1000n, 80n, 10n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1000n }),
    }),
    expect: { kind: "exitBid" },
  },
  {
    name: "over + final == maxPrice → partial with outbidBlock 0 (:573-582)",
    input: input({
      checkpoints: [
        cp(10n, 50n, 0n, 20n),
        cp(20n, 99n, 10n, 1000n),
        cp(1000n, MAX_PRICE, 20n, TAIL_NEXT),
      ],
      auction: auctionCtx({ currentBlock: 1000n }),
    }),
    expect: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 20n,
      outbidBlock: 0n,
    },
  },
  {
    name: "over + final == maxPrice with the bid fully below → hint is its start block",
    input: input({
      checkpoints: [
        cp(10n, 50n, 0n, 1000n),
        cp(1000n, MAX_PRICE, 10n, TAIL_NEXT),
      ],
      auction: auctionCtx({ currentBlock: 1000n }),
    }),
    expect: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 10n,
      outbidBlock: 0n,
    },
  },
];

for (const tc of EXIT_TABLE) {
  test(`deriveExitPlan: ${tc.name}`, () => {
    const plan = deriveExitPlan(tc.input);
    assert.equal(plan.kind, tc.expect.kind);
    if (tc.expect.reason) {
      assert.match(plan.reason, tc.expect.reason);
    }
    if (tc.expect.kind === "exitPartiallyFilledBid") {
      assert.equal(
        plan.lastFullyFilledCheckpointBlock,
        tc.expect.lastFullyFilledCheckpointBlock,
      );
      assert.equal(plan.outbidBlock, tc.expect.outbidBlock);
    }
  });
}

const CLAIM_TABLE = [
  {
    name: "claim needs a prior exit (BidNotExited, :651)",
    bidView: bid({ exitedBlock: 0n, tokensFilled: 5n }),
    auction: auctionCtx({ currentBlock: 1200n }),
    expect: { kind: "unavailable", reason: /exited/ },
  },
  {
    name: "exited with zero fill is settled (:655-658 zeroed it)",
    bidView: bid({ exitedBlock: 5n, tokensFilled: 0n }),
    auction: auctionCtx({ currentBlock: 1200n }),
    expect: { kind: "unavailable", reason: /settled/ },
  },
  {
    name: "claim needs graduation (NotGraduated, :606)",
    bidView: bid({ exitedBlock: 5n, tokensFilled: 5n }),
    auction: auctionCtx({ graduated: false, currentBlock: 1200n }),
    expect: { kind: "unavailable", reason: /graduated/ },
  },
  {
    name: "claim needs the claim block (NotClaimable, StepStorage.sol:57)",
    bidView: bid({ exitedBlock: 5n, tokensFilled: 5n }),
    auction: auctionCtx({ currentBlock: 1050n }),
    expect: { kind: "unavailable", reason: /block 1100/ },
  },
  {
    name: "exited + filled + graduated + past claim block → claim",
    bidView: bid({ exitedBlock: 5n, tokensFilled: 5n }),
    auction: auctionCtx({ currentBlock: 1200n }),
    expect: { kind: "claim" },
  },
];

for (const tc of CLAIM_TABLE) {
  test(`deriveClaimPlan: ${tc.name}`, () => {
    const plan = deriveClaimPlan(tc.bidView, tc.auction);
    assert.equal(plan.kind, tc.expect.kind);
    if (tc.expect.reason) assert.match(plan.reason, tc.expect.reason);
  });
}

const STATUS_TABLE = [
  {
    name: "live + materialized outbid → outbid",
    input: input({
      checkpoints: [cp(10n, 90n, 0n, 20n), cp(20n, 150n, 10n, TAIL_NEXT)],
    }),
    status: "outbid",
  },
  {
    name: "live + in play → active",
    input: input({ checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)] }),
    status: "active",
  },
  {
    name: "over + not exited → ended",
    input: input({
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1000n }),
    }),
    status: "ended",
  },
  {
    name: "exited + tokens owed + claim unlocked → claimable",
    input: input({
      bidView: bid({ exitedBlock: 5n, tokensFilled: 5n }),
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1200n }),
    }),
    status: "claimable",
  },
  {
    name: "exited + tokens owed + claim locked → exited",
    input: input({
      bidView: bid({ exitedBlock: 5n, tokensFilled: 5n }),
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1050n }),
    }),
    status: "exited",
  },
  {
    name: "exited + zero fill → settled",
    input: input({
      bidView: bid({ exitedBlock: 5n, tokensFilled: 0n }),
      checkpoints: [cp(10n, 50n, 0n, TAIL_NEXT)],
      auction: auctionCtx({ currentBlock: 1200n }),
    }),
    status: "settled",
  },
];

for (const tc of STATUS_TABLE) {
  test(`deriveBidActions status: ${tc.name}`, () => {
    assert.equal(deriveBidActions(tc.input).status, tc.status);
  });
}

test("deriveBidActions composes status + exit + claim on one seam", () => {
  const actions = deriveBidActions(
    input({
      checkpoints: [cp(10n, 90n, 0n, 20n), cp(20n, 150n, 10n, TAIL_NEXT)],
    }),
  );
  assert.equal(actions.status, "outbid");
  assert.equal(actions.exit.kind, "exitPartiallyFilledBid");
  assert.equal(actions.claim.kind, "unavailable");
});

// ---------------------------------------------------------------------------
// Plan → execution mapping — golden call vectors
// ---------------------------------------------------------------------------

test("buildExitExecution maps exitBid to the pinned exitBid(42) bytes", async () => {
  const execution = buildExitExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    bidId: 42n,
    plan: { kind: "exitBid" },
  });
  assert.deepEqual(execution.order, ["exit"]);
  const call = await execution.calls[0].build();
  assert.equal(call.data, CAST_EXIT);
  assert.equal(call.to, AUCTION);
  assert.equal(call.value, "0x0");
});

test("buildExitExecution maps partial exit to the pinned (42,123,456) bytes", async () => {
  const execution = buildExitExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    bidId: 42n,
    plan: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 123n,
      outbidBlock: 456n,
    },
  });
  assert.deepEqual(execution.order, ["exit"]);
  const call = await execution.calls[0].build();
  assert.equal(call.data, CAST_EXIT_PARTIALLY_FILLED);
});

test("buildExitCallForPlan refuses plans that are not single calls", () => {
  assert.throws(
    () =>
      buildExitCallForPlan(AUCTION, 42n, {
        kind: "unavailable",
        reason: "not yet",
      }),
    /not yet/,
  );
  assert.throws(
    () => buildExitCallForPlan(AUCTION, 42n, { kind: "checkpointThenExit" }),
    /two-step/,
  );
});

test("checkpointThenExit arms checkpoint then a freshly derived exit", async () => {
  const resolved = [];
  const execution = buildExitExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    bidId: 42n,
    plan: { kind: "checkpointThenExit" },
    resolvePlan: async () => {
      resolved.push(true);
      return {
        kind: "exitPartiallyFilledBid",
        lastFullyFilledCheckpointBlock: 123n,
        outbidBlock: 456n,
      };
    },
  });
  assert.deepEqual(execution.order, ["checkpoint", "exit"]);
  const prep = await execution.calls[0].build();
  assert.equal(prep.data, "0xc2c4c5c1");
  assert.deepEqual(resolved, []);
  const exit = await execution.calls[1].build();
  assert.deepEqual(resolved, [true]);
  assert.equal(exit.data, CAST_EXIT_PARTIALLY_FILLED);
});

test("checkpointThenExit exit step fails by name when re-derivation stalls", async () => {
  const execution = buildExitExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    bidId: 42n,
    plan: { kind: "checkpointThenExit" },
    resolvePlan: async () => ({ kind: "checkpointThenExit" }),
  });
  await assert.rejects(
    () => execution.calls[1].build(),
    /still missing onchain/,
  );
});

test("checkpointThenExit without resolvePlan fails at composition", () => {
  assert.throws(
    () =>
      buildExitExecution({
        rpcUrl: RPC_URL,
        chainId: CHAIN_ID,
        auction: AUCTION,
        bidId: 42n,
        plan: { kind: "checkpointThenExit" },
      }),
    /resolvePlan/,
  );
});

test("buildClaimExecution sends claimTokens(7) for one bid", async () => {
  const execution = buildClaimExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    owner: OWNER,
    bidIds: [7n],
  });
  assert.deepEqual(execution.order, ["claim"]);
  const call = await execution.calls[0].build();
  assert.equal(call.data, CAST_CLAIM);
  assert.equal(call.to, AUCTION);
});

test("buildClaimExecution sends the pinned claimTokensBatch bytes for several", async () => {
  const execution = buildClaimExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    owner: OWNER,
    bidIds: [1n, 2n, 3n],
  });
  const call = await execution.calls[0].build();
  assert.equal(call.data, CAST_CLAIM_BATCH);
});

test("buildClaimExecution rejects an empty batch", () => {
  assert.throws(
    () =>
      buildClaimExecution({
        rpcUrl: RPC_URL,
        chainId: CHAIN_ID,
        auction: AUCTION,
        owner: OWNER,
        bidIds: [],
      }),
    /at least one/,
  );
});

// ---------------------------------------------------------------------------
// runExitFlow — sequential send, named failures, retry-remaining
// ---------------------------------------------------------------------------

function receipt(txHash) {
  return {
    txHash,
    status: "success",
    blockNumber: 1,
    gasUsed: "21000",
    contractAddress: null,
  };
}

/** Fold dispatched actions through the production reducer, recording them. */
function recorder(initial = initialExitFlowState()) {
  let state = initial;
  const actions = [];
  return {
    actions,
    get state() {
      return state;
    },
    dispatch(action) {
      actions.push(action);
      state = exitFlowReducer(state, action);
    },
  };
}

/** Scripted `sendTransaction` fake: queue of receipts, thrown errors, or fns. */
function fakeDeps(script) {
  const sends = [];
  const queue = [...script];
  return {
    sends,
    deps: {
      async sendTransaction(args) {
        sends.push(args);
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted receipt left");
        if (typeof next === "function") return next(args);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function twoStepExecution() {
  return buildExitExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    bidId: 42n,
    plan: { kind: "checkpointThenExit" },
    resolvePlan: async () => ({
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 123n,
      outbidBlock: 456n,
    }),
  });
}

test("runExitFlow runs one step to done", async () => {
  const rec = recorder();
  const { deps, sends } = fakeDeps([receipt("0xaaa")]);
  dispatchReset(rec, ["exit"]);
  await runExitFlow(
    buildExitExecution({
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      auction: AUCTION,
      bidId: 42n,
      plan: { kind: "exitBid" },
    }),
    deps,
    rec.dispatch,
  );
  assert.equal(rec.state.phase, "done");
  assert.equal(rec.state.steps.exit, "done");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, AUCTION);
});

test("runExitFlow names the failed step on a thrown send error", async () => {
  const rec = recorder();
  const { deps } = fakeDeps([new Error("wallet locked")]);
  dispatchReset(rec, ["exit"]);
  await runExitFlow(
    buildExitExecution({
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      auction: AUCTION,
      bidId: 42n,
      plan: { kind: "exitBid" },
    }),
    deps,
    rec.dispatch,
  );
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "exit");
  assert.equal(rec.state.errorMessage, "Exit bid failed — wallet locked");
});

test("runExitFlow treats a mined revert as a failed step, never a success", async () => {
  const rec = recorder();
  const { deps } = fakeDeps([{ ...receipt("0xdead"), status: "reverted" }]);
  dispatchReset(rec, ["claim"]);
  await runExitFlow(
    buildClaimExecution({
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      auction: AUCTION,
      owner: OWNER,
      bidIds: [7n],
    }),
    deps,
    rec.dispatch,
  );
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.steps.claim, "failed");
  assert.match(
    rec.state.errorMessage,
    /Claim tokens failed — the transaction reverted onchain \(tx 0xdead\)/,
  );
});

test("runExitFlow keeps completed steps and retry re-sends only the remainder", async () => {
  const rec = recorder();
  const { deps, sends } = fakeDeps([
    receipt("0xprep"),
    new Error("gas price moved"),
  ]);
  dispatchReset(rec, ["checkpoint", "exit"]);
  await runExitFlow(twoStepExecution(), deps, rec.dispatch);
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "exit");
  assert.match(rec.state.errorMessage, /^Exit bid failed — /);
  assert.deepEqual(remainingExitSteps(rec.state), ["exit"]);
  assert.deepEqual([...completedExitSteps(rec.state)], ["checkpoint"]);

  // Retry: the completed checkpoint step is never re-sent.
  const retryDeps = fakeDeps([receipt("0xexit")]);
  await runExitFlow(
    twoStepExecution(),
    retryDeps.deps,
    rec.dispatch,
    resumeExitFromState(rec.state),
  );
  assert.equal(rec.state.phase, "done");
  assert.equal(retryDeps.sends.length, 1);
  assert.equal(sends.length, 2); // first run: checkpoint + failed exit
  assert.equal(
    retryDeps.sends[0].data.startsWith("0x36dec5f2"),
    true,
    "retry sends the exit call",
  );
});

test("runExitFlow names the step when the fresh exit build rejects", async () => {
  const rec = recorder();
  const execution = buildExitExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    bidId: 42n,
    plan: { kind: "checkpointThenExit" },
    resolvePlan: async () => ({ kind: "unavailable", reason: "not derivable" }),
  });
  const { deps, sends } = fakeDeps([receipt("0xprep")]);
  dispatchReset(rec, ["checkpoint", "exit"]);
  await runExitFlow(execution, deps, rec.dispatch);
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "exit");
  assert.equal(rec.state.errorMessage, "Exit bid failed — not derivable");
  assert.equal(sends.length, 1, "nothing is sent for a step that cannot build");
});

function dispatchReset(rec, order) {
  rec.dispatch({ type: "reset", order });
}

// ---------------------------------------------------------------------------
// fetchCheckpointWalk — bounded linked-list walk
// ---------------------------------------------------------------------------

test("fetchCheckpointWalk follows next to the MAX sentinel", async () => {
  const slots = new Map([
    [10n, cp(10n, 50n, 0n, 20n)],
    [20n, cp(20n, 60n, 10n, TAIL_NEXT)],
  ]);
  const walk = await fetchCheckpointWalk(async (block) => {
    const found = slots.get(block);
    if (!found) throw new Error("missing");
    return found;
  }, 10n);
  assert.deepEqual(
    walk.map((c) => c.block),
    [10n, 20n],
  );
});

test("fetchCheckpointWalk errors instead of truncating at the bound", async () => {
  const chain = (block) => ({
    ...cp(block, 50n, block - 1n, block + 1n),
  });
  await assert.rejects(
    () => fetchCheckpointWalk(async (b) => chain(b), 10n, 3),
    /exceeded 3 steps/,
  );
});

test("fetchCheckpointWalk errors on an unmaterialized link", async () => {
  const slots = new Map([[10n, cp(10n, 50n, 0n, 20n)]]);
  await assert.rejects(
    () =>
      fetchCheckpointWalk(async (block) => {
        const found = slots.get(block);
        return (
          found ?? {
            block,
            clearingPrice: 0n,
            currencyRaisedAtClearingPriceQ96X7: 0n,
            cumulativeMpsPerPrice: 0n,
            cumulativeMps: 0n,
            prev: 0n,
            next: 0n,
          }
        );
      }, 10n),
    /no checkpoint at block 20/,
  );
});

test("EXIT_STEP_LABELS names every step the reducer can fail", () => {
  assert.deepEqual(Object.keys(EXIT_STEP_LABELS).sort(), [
    "checkpoint",
    "claim",
    "exit",
  ]);
});
