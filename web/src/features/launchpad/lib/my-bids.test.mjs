// My-bids derivation + wire shapes — port of `desktop/src/features/launchpad/
// exitHooks.test.mjs` (the cited reference); scenarios carry the same names so
// the port is auditable against it. Goldens are `cast` 1.4.3 output and bind
// this module to the real ABI (ANTI-HALLUCINATION: every selector and word
// layout below is a pinned vector, not a guess).
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBidViewCall,
  buildCheckpointTxCall,
  buildCheckpointViewCall,
  buildClaimExecution,
  buildExitCallForPlan,
  buildExitExecution,
  decodeBidView,
  decodeCheckpointView,
  deriveBidActions,
  deriveClaimPlan,
  deriveExitPlan,
  EXIT_STEP_LABELS,
  fetchCheckpointWalk,
  findOwnedBidIds,
  isCheckpointMaterialized,
  MAX_CHECKPOINT_BLOCK,
  SELECTOR_BIDS,
  SELECTOR_CHECKPOINTS,
  SELECTOR_CLAIM_BLOCK,
  SELECTOR_CLEARING_PRICE,
  SELECTOR_END_BLOCK,
  SELECTOR_IS_GRADUATED,
  buildNoArgViewCall,
} from "./my-bids.ts";

// ---------------------------------------------------------------------------
// Golden vectors. Sources (foundry `cast` 1.4.3-stable): `cast sig`,
// `cast calldata`, and `cast abi-encode` for the struct-return word layouts
// (a static struct return encodes exactly as its tuple). Struct field orders
// are the pinned interfaces: libraries/BidLib.sol:6-14 and
// libraries/CheckpointLib.sol:7-14.
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
  [SELECTOR_BIDS, "0x4423c5f1"],
  [SELECTOR_CHECKPOINTS, "0xb122db60"],
  [SELECTOR_IS_GRADUATED, "0x9e5f2602"],
  [SELECTOR_CLEARING_PRICE, "0x32a0f2d7"],
  [SELECTOR_END_BLOCK, "0x083c6323"],
  [SELECTOR_CLAIM_BLOCK, "0x37dfbc4b"],
];

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

// ---------------------------------------------------------------------------
// View calldata builders — golden vectors
// ---------------------------------------------------------------------------

test("view selectors match `cast sig`", () => {
  for (const [selector, expected] of CAST_SIGS) {
    assert.equal(selector, expected);
  }
});

test("buildBidViewCall matches `cast calldata 'bids(uint256)' 42`", () => {
  assert.equal(buildBidViewCall(42n), CAST_BIDS_42);
});

test("buildCheckpointViewCall matches `cast calldata 'checkpoints(uint64)' 123`", () => {
  assert.equal(buildCheckpointViewCall(123n), CAST_CHECKPOINTS_123);
});

test("buildCheckpointTxCall is the bare checkpoint() selector", () => {
  const call = buildCheckpointTxCall(AUCTION);
  assert.equal(call.data, "0xc2c4c5c1");
  assert.equal(call.to, AUCTION);
  assert.equal(call.value, "0x0");
  assert.equal(
    buildNoArgViewCall(SELECTOR_IS_GRADUATED),
    SELECTOR_IS_GRADUATED,
  );
});

// ---------------------------------------------------------------------------
// Return decoders — pinned struct word layouts
// ---------------------------------------------------------------------------

test("decodeBidView matches the `cast abi-encode` Bid word layout", () => {
  const bid = decodeBidView(CAST_ABI_BID);
  assert.deepEqual(bid, {
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
  const cp = decodeCheckpointView(12n, CAST_ABI_CHECKPOINT);
  assert.deepEqual(cp, {
    block: 12n,
    clearingPrice: 7n,
    currencyRaisedAtClearingPriceQ96X7: 8n,
    cumulativeMpsPerPrice: 9n,
    cumulativeMps: 10n,
    prev: 11n,
    next: MAX_CHECKPOINT_BLOCK,
  });
});

test("decoders reject wrong-size returns (no silent success)", () => {
  assert.throws(() => decodeBidView(`0x${"0".repeat(64 * 6)}`), /ABI words/);
  assert.throws(() => decodeCheckpointView(1n, "0x1234"), /ABI words/);
});

test("isCheckpointMaterialized distinguishes empty slots from the tail", () => {
  const empty = decodeCheckpointView(5n, `0x${"0".repeat(64 * 6)}`);
  assert.equal(isCheckpointMaterialized(empty), false);
  const tail = decodeCheckpointView(5n, CAST_ABI_CHECKPOINT);
  assert.equal(isCheckpointMaterialized(tail), true);
});

// ---------------------------------------------------------------------------
// deriveBidActions — table over the input combination space
// (port of exitHooks.test.mjs:218-560)
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
// Plan → execution mapping — golden call vectors (port :545-705)
// ---------------------------------------------------------------------------

test("buildExitCallForPlan maps exitBid to the pinned exitBid(42) bytes", async () => {
  const execution = buildExitExecution({
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

test("buildExitCallForPlan maps partial exit to the pinned (42,123,456) bytes", async () => {
  const execution = buildExitExecution({
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
        auction: AUCTION,
        bidId: 42n,
        plan: { kind: "checkpointThenExit" },
      }),
    /resolvePlan/,
  );
});

test("buildClaimExecution sends claimTokens(7) for one bid", async () => {
  const execution = buildClaimExecution({
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
    auction: AUCTION,
    owner: OWNER,
    bidIds: [1n, 2n, 3n],
  });
  const call = await execution.calls[0].build();
  assert.equal(call.data, CAST_CLAIM_BATCH);
});

test("buildClaimExecution rejects an empty batch", () => {
  assert.throws(
    () => buildClaimExecution({ auction: AUCTION, owner: OWNER, bidIds: [] }),
    /at least one/,
  );
});

// ---------------------------------------------------------------------------
// fetchCheckpointWalk — bounded linked-list walk (port :889-935)
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

// ---------------------------------------------------------------------------
// findOwnedBidIds — the web `evm_find_bid_ids` log scan
// (BidSubmitted(uint256 indexed id, address indexed owner, …),
// IContinuousClearingAuction.sol:103)
// ---------------------------------------------------------------------------

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, ...handler(body) }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("findOwnedBidIds scans BidSubmitted logs by owner topic and sorts ids", async () => {
  const ownerTopic = `0x${"0".repeat(24)}${OWNER.slice(2).toLowerCase()}`;
  const restore = stubFetch((body) => {
    assert.equal(body.method, "eth_getLogs");
    const filter = body.params[0];
    assert.equal(filter.address, AUCTION);
    assert.equal(
      filter.topics[0],
      "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540",
    );
    assert.equal(filter.topics[1], null);
    assert.equal(filter.topics[2], ownerTopic);
    return {
      result: [
        {
          address: AUCTION,
          topics: [
            "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540",
            `0x${"0".repeat(63)}9`,
            ownerTopic,
          ],
          data: "0x",
          blockNumber: "0x1",
          transactionHash: `0x${"ab".repeat(32)}`,
          logIndex: "0x0",
        },
        {
          address: AUCTION,
          topics: [
            "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540",
            `0x${"0".repeat(63)}2`,
            ownerTopic,
          ],
          data: "0x",
          blockNumber: "0x1",
          transactionHash: `0x${"cd".repeat(32)}`,
          logIndex: "0x1",
        },
      ],
    };
  });
  try {
    const ids = await findOwnedBidIds("http://rpc.test", AUCTION, OWNER);
    assert.deepEqual(ids, [2n, 9n]);
  } finally {
    restore();
  }
});
