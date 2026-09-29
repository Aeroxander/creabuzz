import assert from "node:assert/strict";
import test from "node:test";

import {
  auctionDeployReducer,
  buildFactoryCreateCall,
  buildFactoryGetAddressView,
  deriveAuctionDeployParams,
  deployResumeIndex,
  encodeAuctionConfigData,
  initAuctionDeployState,
  retryPlan,
  runAuctionDeploy,
  SELECTOR_FACTORY_CREATE,
  SELECTOR_FACTORY_GET_ADDRESS,
  SELECTOR_FUNDS_RECIPIENT,
  SELECTOR_GRADUATIONS,
  SELECTOR_IS_GRADUATED,
  SELECTOR_LBP_INITIALIZATION_PARAMS,
  SELECTOR_TOKENS_RECIPIENT,
  uniformAuctionSteps,
} from "./auctionFlow.ts";
import {
  checkGraduationReadiness,
  decodeGraduationRecord,
  decodeLbpParams,
  GRADUATION_STEPS,
  graduationFlowReducer,
  graduationRetryPlan,
  initialGraduationState,
  lockReceiptParts,
  runGraduationFlow,
  sweepReceiptParts,
} from "./graduationFlow.ts";
import {
  SELECTOR_BIND_AUCTION,
  SELECTOR_BOUND_AUCTION,
  SELECTOR_ERC20_BALANCE_OF,
  SELECTOR_ERC20_TRANSFER,
  SELECTOR_ON_TOKENS_RECEIVED,
} from "./evmCalls.ts";
import {
  ALLOWLIST_HOOK_CREATION_BYTECODE,
  GRADUATION_EXECUTOR_CREATION_BYTECODE,
  predictCreateAddress,
} from "./graduationArtifact.ts";

// ---------------------------------------------------------------------------
// Golden vectors (fresh `cast` output; do not hand-edit hex).
//
// Fixture PLAN below is exactly the argument set used for:
//   `cast abi-encode "x((address,address,address,uint64,uint64,uint64,
//      uint256,address,uint256,uint128,bytes))" "(...)"`      → CAST_CONFIG_DATA
//   `cast calldata "create(address,uint256,bytes,bytes32)" …`  → CAST_FACTORY_CREATE
//   `cast calldata "getAddress(address,uint256,bytes,bytes32,
//      address)" …`                                            → CAST_FACTORY_GET_ADDRESS
// (token 0x4444…, amount 1e24, salt 1, sender 0x2222…, executor + recipients
// 0x3333…, currency 0x6666…, blocks 1000/1010/1020, floor 2^32+1, tick 100,
// threshold 1e9, steps 0x0f424000000000090f42400000000001 — the uniform
// schedule `uniformAuctionSteps(1000, 1010)` derives).
// ---------------------------------------------------------------------------

// `cast sig` pins:
//   create(address,uint256,bytes,bytes32) -> 0x4aaa5b37
//   getAddress(address,uint256,bytes,bytes32,address) -> 0x1bfb751b
//   graduations(address) -> 0x62e3857f
//   fundsRecipient() -> 0x3b6fd2cf   tokensRecipient() -> 0xfd637557
//   isGraduated() -> 0x9e5f2602      lbpInitializationParams() -> 0xe1d97d1f
const CAST_SIGS = {
  create: "0x4aaa5b37",
  getAddress: "0x1bfb751b",
  graduations: "0x62e3857f",
  fundsRecipient: "0x3b6fd2cf",
  tokensRecipient: "0xfd637557",
  isGraduated: "0x9e5f2602",
  lbp: "0xe1d97d1f",
};

const CAST_CONFIG_DATA =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "0000000000000000000000006666666666666666666666666666666666666666" +
  "0000000000000000000000003333333333333333333333333333333333333333" +
  "0000000000000000000000003333333333333333333333333333333333333333" +
  "00000000000000000000000000000000000000000000000000000000000003e8" +
  "00000000000000000000000000000000000000000000000000000000000003f2" +
  "00000000000000000000000000000000000000000000000000000000000003fc" +
  "0000000000000000000000000000000000000000000000000000000000000064" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000100000001" +
  "000000000000000000000000000000000000000000000000000000003b9aca00" +
  "0000000000000000000000000000000000000000000000000000000000000160" +
  "0000000000000000000000000000000000000000000000000000000000000010" +
  "0f424000000000090f4240000000000100000000000000000000000000000000";
const CAST_FACTORY_CREATE =
  "0x" +
  "4aaa5b3700000000000000000000000044444444444444444444444444444444" +
  "4444444400000000000000000000000000000000000000000000d3c21bcecced" +
  "a0ffffff00000000000000000000000000000000000000000000000000000000" +
  "0000008000000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "000001c000000000000000000000000000000000000000000000000000000000" +
  "0000002000000000000000000000000066666666666666666666666666666666" +
  "6666666600000000000000000000000033333333333333333333333333333333" +
  "3333333300000000000000000000000033333333333333333333333333333333" +
  "3333333300000000000000000000000000000000000000000000000000000000" +
  "000003e800000000000000000000000000000000000000000000000000000000" +
  "000003f200000000000000000000000000000000000000000000000000000000" +
  "000003fc00000000000000000000000000000000000000000000000000000000" +
  "0000006400000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "3b9aca0000000000000000000000000000000000000000000000000000000000" +
  "0000016000000000000000000000000000000000000000000000000000000000" +
  "000000100f424000000000090f42400000000001000000000000000000000000" +
  "00000000";
const CAST_FACTORY_GET_ADDRESS =
  "0x" +
  "1bfb751b00000000000000000000000044444444444444444444444444444444" +
  "4444444400000000000000000000000000000000000000000000d3c21bcecced" +
  "a0ffffff00000000000000000000000000000000000000000000000000000000" +
  "000000a000000000000000000000000000000000000000000000000000000000" +
  "0000000100000000000000000000000022222222222222222222222222222222" +
  "2222222200000000000000000000000000000000000000000000000000000000" +
  "000001c000000000000000000000000000000000000000000000000000000000" +
  "0000002000000000000000000000000066666666666666666666666666666666" +
  "6666666600000000000000000000000033333333333333333333333333333333" +
  "3333333300000000000000000000000033333333333333333333333333333333" +
  "3333333300000000000000000000000000000000000000000000000000000000" +
  "000003e800000000000000000000000000000000000000000000000000000000" +
  "000003f200000000000000000000000000000000000000000000000000000000" +
  "000003fc00000000000000000000000000000000000000000000000000000000" +
  "0000006400000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000100000000000000000000000000000000000000000000000000000000" +
  "3b9aca0000000000000000000000000000000000000000000000000000000000" +
  "0000016000000000000000000000000000000000000000000000000000000000" +
  "000000100f424000000000090f42400000000001000000000000000000000000" +
  "00000000";

const PLAN = {
  token: "0x4444444444444444444444444444444444444444",
  tokenSupply: "1000000",
  currency: "0x6666666666666666666666666666666666666666",
  floorPrice: "4294967297",
  tickSpacing: "100",
  requiredRaised: "1000000000",
  startBlock: 1000,
  endBlock: 1010,
  claimBlock: 1020,
  treasury: "0x1111111111111111111111111111111111111111",
  admission: "community",
};
const FACTORY = "0x000000001F26a0044BaA66024e7b6599c61963F8";
const DEPLOYER = "0x2222222222222222222222222222222222222222";
const EXECUTOR_GOLDEN = "0x3333333333333333333333333333333333333333";
const AUCTION_ADDR = "0x5555555555555555555555555555555555555555";
const TX1 = `0x${"11".repeat(32)}`;
const TX2 = `0x${"22".repeat(32)}`;

const addrWord = (address) =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const uintWord = (n) => `0x${n.toString(16).padStart(64, "0")}`;
/** Concatenate single-word returns into ONE multi-word return payload. */
const rawWords = (...parts) =>
  `0x${parts.map((p) => p.replace(/^0x/, "")).join("")}`;

function fold(reducer, init, actions) {
  return actions.reduce(reducer, init);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test("factory/graduation selectors match cast sig pins", () => {
  assert.equal(SELECTOR_FACTORY_CREATE, CAST_SIGS.create);
  assert.equal(SELECTOR_FACTORY_GET_ADDRESS, CAST_SIGS.getAddress);
  assert.equal(SELECTOR_GRADUATIONS, CAST_SIGS.graduations);
  assert.equal(SELECTOR_FUNDS_RECIPIENT, CAST_SIGS.fundsRecipient);
  assert.equal(SELECTOR_TOKENS_RECIPIENT, CAST_SIGS.tokensRecipient);
  assert.equal(SELECTOR_IS_GRADUATED, CAST_SIGS.isGraduated);
  assert.equal(SELECTOR_LBP_INITIALIZATION_PARAMS, CAST_SIGS.lbp);
});

// ---------------------------------------------------------------------------
// Issuance schedule
// ---------------------------------------------------------------------------

function parseSteps(hex) {
  const body = hex.replace(/^0x/, "");
  assert.equal(body.length % 16, 0, "steps pack as 8-byte words");
  const steps = [];
  for (let i = 0; i < body.length; i += 16) {
    steps.push({
      mps: BigInt(`0x${body.slice(i, i + 6)}`),
      blockDelta: BigInt(`0x${body.slice(i + 6, i + 16)}`),
    });
  }
  return steps;
}

test("uniformAuctionSteps matches the cast golden schedule for 1000..1010", () => {
  assert.equal(
    uniformAuctionSteps(1000, 1010),
    "0x0f424000000000090f42400000000001",
  );
});

test("uniformAuctionSteps single-block sale is one full-mps step", () => {
  assert.equal(uniformAuctionSteps(5, 6), "0x9896800000000001");
});

test("uniformAuctionSteps invariants hold across the input space", () => {
  for (const n of [1, 2, 3, 7, 10, 99, 1000, 123456]) {
    const steps = parseSteps(uniformAuctionSteps(1000, 1000 + n));
    const sold = steps.reduce((acc, s) => acc + s.mps * s.blockDelta, 0n);
    const blocks = steps.reduce((acc, s) => acc + s.blockDelta, 0n);
    assert.equal(sold, 10_000_000n, `mps sum for n=${n}`);
    assert.equal(blocks, BigInt(n), `delta sum for n=${n}`);
  }
});

test("uniformAuctionSteps rejects unschedulable windows", () => {
  assert.throws(() => uniformAuctionSteps(10, 10), /at least one block/);
  assert.throws(() => uniformAuctionSteps(10, 9), /at least one block/);
  // mps would round to 0 — bounded, not silently wrong (rule 4).
  assert.throws(() => uniformAuctionSteps(0, 20_000_000), /too long/);
});

// ---------------------------------------------------------------------------
// Plan derivation (the AuctionLauncher parameter gate)
// ---------------------------------------------------------------------------

test("deriveAuctionDeployParams maps the record fields", () => {
  const params = deriveAuctionDeployParams(PLAN);
  assert.equal(params.token, PLAN.token);
  // One wei short of the supply: StandardPool locks 1 wei in the router.
  assert.equal(params.amount, 1_000_000n * 10n ** 18n - 1n);
  assert.equal(params.currency, PLAN.currency);
  assert.equal(params.floorPrice, 4294967297n);
  assert.equal(params.tickSpacing, 100n);
  assert.equal(params.requiredRaised, 1000000000n);
  assert.equal(params.auctionStepsData, "0x0f424000000000090f42400000000001");
  assert.equal(params.hookPerWalletCap, null, "community ships no hook");
  const curated = deriveAuctionDeployParams({ ...PLAN, admission: "curated" });
  assert.equal(
    curated.hookPerWalletCap,
    1000000000n,
    "cap defaults to the threshold",
  );
});

test("a native (ETH) sale is accepted, however 'native' is spelled", () => {
  // The executor takes ETH through receive() and pays it out natively, so
  // null / "" / the zero address all mean an ETH sale and resolve to zero.
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const currency of [null, "", "  ", ZERO]) {
    assert.equal(
      deriveAuctionDeployParams({ ...PLAN, currency }).currency,
      ZERO,
      `currency ${JSON.stringify(currency)}`,
    );
  }
});

test("deriveAuctionDeployParams enforces every parameter gate", () => {
  const cases = [
    [{ ...PLAN, token: "" }, /token address/],
    [{ ...PLAN, treasury: "" }, /treasury/],
    [{ ...PLAN, tokenSupply: "0" }, /supply must be positive/],
    [{ ...PLAN, tokenSupply: "1.5" }, /token plan supply/],
    [{ ...PLAN, tokenSupply: `1${"0".repeat(21)}` }, /uint128/],
    [{ ...PLAN, currency: "usdc" }, /currency/],
    [{ ...PLAN, floorPrice: "1000000" }, /floorPrice.*2\^32/],
    [{ ...PLAN, tickSpacing: "1" }, /tickSpacing/],
    [{ ...PLAN, requiredRaised: "0" }, /requiredRaised/],
    [{ ...PLAN, requiredRaised: `1${"0".repeat(39)}` }, /uint128/],
    [{ ...PLAN, startBlock: null }, /startBlock is missing/],
    [{ ...PLAN, startBlock: 0 }, /BadBlocks/],
    [{ ...PLAN, endBlock: 1000 }, /BadBlocks/],
    [{ ...PLAN, claimBlock: 1010 }, /BadBlocks/],
  ];
  for (const [inputs, pattern] of cases) {
    assert.throws(
      () => deriveAuctionDeployParams(inputs),
      (error) => {
        assert.equal(error.name, "AuctionPrepareError");
        assert.equal(error.stage, "plan");
        assert.match(error.message, pattern);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Calldata goldens (the factory deploy path)
// ---------------------------------------------------------------------------

test("encodeAuctionConfigData matches cast abi-encode", () => {
  const params = deriveAuctionDeployParams(PLAN);
  assert.equal(
    encodeAuctionConfigData({
      params,
      executor: EXECUTOR_GOLDEN,
      hook: null,
    }),
    CAST_CONFIG_DATA,
  );
});

test("buildFactoryCreateCall matches cast calldata", () => {
  const params = deriveAuctionDeployParams(PLAN);
  const call = buildFactoryCreateCall({
    factory: FACTORY,
    params,
    configData: CAST_CONFIG_DATA,
    salt: 1n,
  });
  assert.deepEqual(call, {
    to: FACTORY,
    data: CAST_FACTORY_CREATE,
    value: "0x0",
  });
  assert.ok(call.data.startsWith(SELECTOR_FACTORY_CREATE));
});

test("buildFactoryGetAddressView matches cast calldata", () => {
  const params = deriveAuctionDeployParams(PLAN);
  const view = buildFactoryGetAddressView({
    factory: FACTORY,
    params,
    configData: CAST_CONFIG_DATA,
    salt: 1n,
    sender: DEPLOYER,
  });
  assert.deepEqual(view, { to: FACTORY, data: CAST_FACTORY_GET_ADDRESS });
  assert.ok(view.data.startsWith(SELECTOR_FACTORY_GET_ADDRESS));
});

test("configData rejects invalid executor/hook addresses", () => {
  const params = deriveAuctionDeployParams(PLAN);
  assert.throws(
    () => encodeAuctionConfigData({ params, executor: "nope", hook: null }),
    /executor address/,
  );
  assert.throws(
    () =>
      encodeAuctionConfigData({
        params,
        executor: EXECUTOR_GOLDEN,
        hook: "nope",
      }),
    /validation hook/,
  );
});

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

test("decodeLbpParams reads the 3-word LBPInitializationParams", () => {
  const raw = rawWords(uintWord(1n), uintWord(2n), uintWord(3n));
  assert.deepEqual(decodeLbpParams(raw), {
    initialPriceX96: 1n,
    tokensSold: 2n,
    currencyRaised: 3n,
  });
  assert.throws(() => decodeLbpParams(uintWord(1n)), /3 words/);
});

test("decodeGraduationRecord reads the 8-word Graduation struct", () => {
  const raw = rawWords(
    uintWord(1n),
    uintWord(2n),
    uintWord(3n),
    uintWord(4n),
    uintWord(5n),
    uintWord(6n),
    addrWord(EXECUTOR_GOLDEN),
    uintWord(1n),
  );
  assert.deepEqual(decodeGraduationRecord(raw), {
    initialPriceX96: 1n,
    tokensSold: 2n,
    currencyRaised: 3n,
    reserveEscrow: 4n,
    treasuryShare: 5n,
    unsoldTokens: 6n,
    tokenMasterPool: EXECUTOR_GOLDEN,
    executed: true,
  });
  assert.throws(() => decodeGraduationRecord(uintWord(1n)), /8 words/);
});

// ---------------------------------------------------------------------------
// 47005 receipts (`sweep` / `lock`)
// ---------------------------------------------------------------------------

test("sweep/lock receipts carry the relay's tx binding and fixed vocabulary", () => {
  const sweep = sweepReceiptParts({
    auction: AUCTION_ADDR,
    tx: TX1,
    currencyRaised: 3n,
    treasuryShare: 2n,
    unsoldTokens: 6n,
  });
  assert.deepEqual(sweep.extraTags, [
    ["kind", "sweep"],
    ["tx", TX1],
  ]);
  assert.deepEqual(sweep.content, {
    table: "sweep",
    auction: AUCTION_ADDR,
    currencyRaised: "3",
    treasuryShare: "2",
    unsoldTokens: "6",
  });
  const lock = lockReceiptParts({
    auction: AUCTION_ADDR,
    tx: TX1,
    reserveEscrow: 1n,
  });
  assert.deepEqual(lock.extraTags, [
    ["kind", "lock"],
    ["tx", TX1],
  ]);
  assert.deepEqual(lock.content, {
    table: "lock",
    auction: AUCTION_ADDR,
    reserveEscrow: "1",
  });
});

test("receipt builders reject a malformed tx hash (the relay would too)", () => {
  assert.throws(
    () =>
      sweepReceiptParts({
        auction: AUCTION_ADDR,
        tx: "0x1234",
        currencyRaised: 0n,
        treasuryShare: 0n,
        unsoldTokens: 0n,
      }),
    /tx hash/,
  );
  assert.throws(
    () =>
      lockReceiptParts({
        auction: AUCTION_ADDR,
        tx: "nope",
        reserveEscrow: 0n,
      }),
    /tx hash/,
  );
});

// ---------------------------------------------------------------------------
// Deploy reducer + retry plan
// ---------------------------------------------------------------------------

test("deploy reducer tracks steps, addresses, and partial failure", () => {
  let state = initAuctionDeployState("curated");
  assert.equal(state.steps.hook.status, "pending");
  assert.equal(
    initAuctionDeployState("community").steps.hook.status,
    "skipped",
  );

  state = auctionDeployReducer(state, { type: "begin", mode: "fresh" });
  assert.equal(state.phase, "preparing");
  state = auctionDeployReducer(state, {
    type: "step_started",
    step: "executor",
  });
  state = auctionDeployReducer(state, {
    type: "step_address",
    step: "executor",
    address: EXECUTOR_GOLDEN,
  });
  state = auctionDeployReducer(state, {
    type: "step_failed",
    step: "executor",
    txHash: TX1,
    outcome: "reverted",
    reason: "boom",
  });
  assert.equal(state.phase, "paused");
  assert.equal(state.steps.executor.status, "failed");
  assert.equal(state.steps.executor.address, EXECUTOR_GOLDEN);
  assert.deepEqual(
    { ...state.failure, reason: state.failure.reason },
    {
      stage: "step",
      check: null,
      step: "executor",
      txHash: TX1,
      outcome: "reverted",
      reason: "boom",
    },
  );
  assert.deepEqual(retryPlan(state), { kind: "steps", resumeAt: 0 });

  // Resume keeps done steps and the failed step's predicted address.
  state = auctionDeployReducer(state, { type: "begin", mode: "resume" });
  assert.equal(state.steps.executor.status, "pending");
  assert.equal(state.steps.executor.address, EXECUTOR_GOLDEN);

  state = auctionDeployReducer(state, {
    type: "step_done",
    step: "executor",
    txHash: TX2,
    address: EXECUTOR_GOLDEN,
    alreadyDeployed: false,
  });
  state = auctionDeployReducer(state, {
    type: "prepared",
    auctionAddress: AUCTION_ADDR,
  });
  state = auctionDeployReducer(state, { type: "link_started" });
  state = auctionDeployReducer(state, {
    type: "link_failed",
    reason: "publish failed",
  });
  assert.equal(state.phase, "paused");
  assert.deepEqual(retryPlan(state), {
    kind: "record",
    auctionAddress: AUCTION_ADDR,
  });
  state = auctionDeployReducer(state, { type: "linked" });
  assert.equal(state.phase, "success");
  assert.equal(retryPlan(state), null);
});

test("deploy retryPlan is null outside paused, and link retry needs an address", () => {
  let state = initAuctionDeployState();
  assert.equal(retryPlan(state), null);
  state = auctionDeployReducer(state, { type: "link_started" });
  state = auctionDeployReducer(state, { type: "link_failed", reason: "x" });
  assert.equal(retryPlan(state), null, "no auction address yet");
  assert.equal(deployResumeIndex(initAuctionDeployState("community")), 1);
  assert.equal(deployResumeIndex(initAuctionDeployState("curated")), 0);
});

// ---------------------------------------------------------------------------
// Deploy runner (scripted fakes — the production seam)
// ---------------------------------------------------------------------------

function collectingDispatch() {
  const actions = [];
  return { actions, dispatch: (action) => actions.push(action) };
}

function successReceipt(txHash, contractAddress = null) {
  return {
    txHash,
    status: "success",
    blockNumber: 5,
    gasUsed: "1",
    contractAddress,
  };
}

test("runAuctionDeploy (community) sends executor CREATE (no `to`) then factory create", async () => {
  const { actions, dispatch } = collectingDispatch();
  const sends = [];
  const links = [];
  const predicted = predictCreateAddress(DEPLOYER, 7n);
  let auctionCodeChecks = 0;
  const effects = {
    // Every view answers with the auction address: the factory's getAddress,
    // and (by coincidence of the fixture) "already funded / already bound".
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) => {
      sends.push(call);
      return successReceipt(sends.length === 1 ? TX1 : TX2, null);
    },
    codeAt: async (address) => {
      if (address === AUCTION_ADDR) return auctionCodeChecks++ > 0;
      return false;
    },
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous: initAuctionDeployState("community"),
    onLink: async (input) => {
      links.push(input);
    },
  });

  // executor CREATE + factory create + onTokensReceived (the funding and bind
  // views read as already satisfied here; see the scripted-chain test below).
  assert.equal(sends.length, 3);
  assert.equal(sends[2].to, AUCTION_ADDR);
  assert.ok(sends[2].data.startsWith(SELECTOR_ON_TOKENS_RECEIVED));
  // IPC contract: `to` OMITTED = contract creation.
  assert.equal(sends[0].to, undefined);
  assert.ok(sends[0].data.startsWith(GRADUATION_EXECUTOR_CREATION_BYTECODE));
  assert.equal(sends[1].to, FACTORY);
  assert.ok(sends[1].data.startsWith(SELECTOR_FACTORY_CREATE));

  const state = fold(
    auctionDeployReducer,
    initAuctionDeployState("community"),
    actions,
  );
  assert.equal(state.phase, "success");
  assert.equal(state.steps.hook.status, "skipped");
  assert.equal(state.steps.executor.status, "done");
  assert.equal(
    state.steps.executor.address,
    predicted,
    "no receipt address -> prediction",
  );
  assert.equal(state.steps.executor.txHash, TX1);
  assert.equal(state.steps.auction.address, AUCTION_ADDR);
  assert.deepEqual(links, [{ auction: AUCTION_ADDR }]);
});

test("runAuctionDeploy (curated) deploys the AllowlistHook first", async () => {
  const { dispatch } = collectingDispatch();
  const sends = [];
  let auctionLive = false;
  const effects = {
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) => {
      sends.push(call);
      if (call.to === FACTORY) auctionLive = true;
      return successReceipt(TX1);
    },
    codeAt: async (address) => address === AUCTION_ADDR && auctionLive,
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  await runAuctionDeploy({
    effects,
    plan: { ...PLAN, admission: "curated" },
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous: initAuctionDeployState("curated"),
    onLink: async () => {},
  });
  assert.equal(sends.length, 4, "hook + executor + factory + onTokensReceived");
  assert.ok(sends[0].data.startsWith(ALLOWLIST_HOOK_CREATION_BYTECODE));
  assert.ok(sends[1].data.startsWith(GRADUATION_EXECUTOR_CREATION_BYTECODE));
  assert.equal(sends[2].to, FACTORY);
  assert.ok(sends[3].data.startsWith(SELECTOR_ON_TOKENS_RECEIVED));
});

test("runAuctionDeploy funds the auction, opens bidding and binds the executor (scripted chain)", async () => {
  const { actions, dispatch } = collectingDispatch();
  const sends = [];
  const AMOUNT = 10n ** 24n - 1n;
  const effects = {
    call: async ({ to, data }) => {
      if (data.startsWith(SELECTOR_FACTORY_GET_ADDRESS)) {
        return addrWord(AUCTION_ADDR);
      }
      if (data.startsWith(SELECTOR_ERC20_BALANCE_OF)) {
        // The auction holds nothing yet; the deploying wallet holds the supply.
        return to === PLAN.token &&
          data.toLowerCase().includes(AUCTION_ADDR.slice(2).toLowerCase())
          ? uintWord(0n)
          : uintWord(AMOUNT);
      }
      if (data.startsWith(SELECTOR_BOUND_AUCTION)) {
        return addrWord("0x0000000000000000000000000000000000000000");
      }
      throw new Error(`unexpected view ${data.slice(0, 10)}`);
    },
    send: async (call) => {
      sends.push(call);
      return successReceipt(
        `0x${String(sends.length).padStart(64, "0")}`,
        null,
      );
    },
    codeAt: async (address) => address !== AUCTION_ADDR || sends.length >= 2,
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous: initAuctionDeployState("community"),
    onLink: async () => {},
  });

  const kinds = sends.map((c) =>
    c.to === undefined
      ? "create"
      : c.data.slice(0, 10) === SELECTOR_ERC20_TRANSFER
        ? "transfer"
        : c.data.slice(0, 10) === SELECTOR_ON_TOKENS_RECEIVED
          ? "onTokensReceived"
          : c.data.slice(0, 10) === SELECTOR_BIND_AUCTION
            ? "bindAuction"
            : "factory",
  );
  assert.deepEqual(kinds, [
    "create",
    "factory",
    "transfer",
    "onTokensReceived",
    "bindAuction",
  ]);
  assert.equal(sends[2].to, PLAN.token, "the supply moves via the token");
  assert.ok(
    sends[2].data.toLowerCase().includes(AUCTION_ADDR.slice(2).toLowerCase()),
    "…to the auction",
  );
  assert.equal(sends[3].to, AUCTION_ADDR);
  const state = fold(
    auctionDeployReducer,
    initAuctionDeployState("community"),
    actions,
  );
  assert.equal(state.phase, "success");
  assert.equal(state.steps.fund.status, "done");
  assert.equal(state.steps.received.status, "done");
  assert.equal(state.steps.bind.status, "done");
  assert.equal(state.steps.hookAuction.status, "skipped");
});

test("runAuctionDeploy names the wallet when it cannot fund the auction", async () => {
  const { actions, dispatch } = collectingDispatch();
  const effects = {
    call: async ({ data }) => {
      if (data.startsWith(SELECTOR_FACTORY_GET_ADDRESS)) {
        return addrWord(AUCTION_ADDR);
      }
      return uintWord(0n); // nobody holds any of the sale token
    },
    send: async () => successReceipt(TX1, null),
    codeAt: async (address) => address !== AUCTION_ADDR || true,
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous: initAuctionDeployState("community"),
    onLink: async () => {},
  });
  const state = fold(
    auctionDeployReducer,
    initAuctionDeployState("community"),
    actions,
  );
  assert.equal(state.phase, "paused");
  assert.equal(state.failure.step, "fund");
  assert.match(state.failure.reason, new RegExp(DEPLOYER.slice(2), "i"));
});

test("runAuctionDeploy halts on a mined revert, names the step, and resumes at a fresh nonce", async () => {
  const first = collectingDispatch();
  let nonce = 7n;
  const sends = [];
  let failExecutor = true;
  let auctionLive = false;
  const effects = {
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) => {
      sends.push(call);
      if (failExecutor && call.to === undefined) {
        return {
          txHash: TX1,
          status: "reverted",
          blockNumber: 5,
          gasUsed: "1",
          contractAddress: null,
        };
      }
      if (call.to !== undefined) auctionLive = true;
      return successReceipt(TX2);
    },
    codeAt: async (address) => address === AUCTION_ADDR && auctionLive,
    transactionCount: async () => nonce,
    blockNumber: async () => 0n,
  };
  const previous = initAuctionDeployState("community");
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch: first.dispatch,
    mode: "fresh",
    previous,
    onLink: async () => {},
  });

  const failedState = fold(auctionDeployReducer, previous, first.actions);
  assert.equal(failedState.phase, "paused");
  assert.deepEqual(
    {
      stage: failedState.failure.stage,
      step: failedState.failure.step,
      outcome: failedState.failure.outcome,
      txHash: failedState.failure.txHash,
    },
    { stage: "step", step: "executor", outcome: "reverted", txHash: TX1 },
  );
  assert.equal(sends.length, 1, "halted before the factory call");
  assert.match(failedState.failure.reason, /reverted in block 5/);
  assert.deepEqual(retryPlan(failedState), { kind: "steps", resumeAt: 1 });

  // Retry: the reverted CREATE consumed its nonce, so the prediction moves.
  failExecutor = false;
  nonce = 8n;
  const second = collectingDispatch();
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch: second.dispatch,
    mode: "resume",
    previous: failedState,
    onLink: async () => {},
  });
  const resumed = fold(auctionDeployReducer, failedState, second.actions);
  assert.equal(resumed.phase, "success");
  assert.equal(
    resumed.steps.executor.address,
    predictCreateAddress(DEPLOYER, 8n),
    "resume re-predicts from the current nonce",
  );
  assert.equal(
    sends.length,
    4,
    "executor + factory + onTokensReceived on retry (the reverted CREATE was send #1)",
  );
});

test("runAuctionDeploy treats code at the predicted address as done (no re-send)", async () => {
  const { actions, dispatch } = collectingDispatch();
  const predicted = predictCreateAddress(DEPLOYER, 7n);
  const sends = [];
  let attempt = 0;
  let auctionLive = false;
  const effects = {
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) => {
      sends.push(call);
      if (call.to === undefined) {
        attempt += 1;
        if (attempt === 1) throw new Error("transport died");
        return successReceipt(TX1);
      }
      auctionLive = true;
      return successReceipt(TX2);
    },
    codeAt: async (address) =>
      address === predicted ? attempt > 0 : auctionLive,
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  const previous = initAuctionDeployState("community");
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous,
    onLink: async () => {},
  });
  const failedState = fold(auctionDeployReducer, previous, actions);
  assert.equal(failedState.failure.outcome, "unknown");
  assert.equal(failedState.steps.executor.address, predicted);

  const second = collectingDispatch();
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch: second.dispatch,
    mode: "resume",
    previous: failedState,
    onLink: async () => {},
  });
  const resumed = fold(auctionDeployReducer, failedState, second.actions);
  assert.equal(resumed.phase, "success");
  assert.equal(resumed.steps.executor.alreadyDeployed, true);
  assert.equal(
    sends.filter((c) => c.to === undefined).length,
    1,
    "the CREATE was never re-sent",
  );
});

test("runAuctionDeploy skips the factory send when the CREATE2 address is live", async () => {
  const { actions, dispatch } = collectingDispatch();
  const sends = [];
  const links = [];
  const effects = {
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) => {
      sends.push(call);
      return successReceipt(TX1);
    },
    codeAt: async (address) => address === AUCTION_ADDR,
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  const previous = initAuctionDeployState("community");
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous,
    onLink: async (input) => {
      links.push(input);
    },
  });
  const state = fold(auctionDeployReducer, previous, actions);
  assert.equal(state.phase, "success");
  assert.equal(state.steps.auction.alreadyDeployed, true);
  assert.equal(
    sends.length,
    2,
    "executor CREATE + onTokensReceived (funding/bind read as satisfied)",
  );
  assert.ok(
    sends.every((c) => c.to !== FACTORY),
    "the factory create is skipped when the CREATE2 address is live",
  );
  assert.deepEqual(links, [{ auction: AUCTION_ADDR }]);
});

test("runAuctionDeploy record failure keeps the deploy and offers record-only retry", async () => {
  const { actions, dispatch } = collectingDispatch();
  const effects = {
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) =>
      successReceipt(
        call.to === undefined ? TX1 : TX2,
        call.to === undefined ? EXECUTOR_GOLDEN : null,
      ),
    codeAt: async (address) => address === AUCTION_ADDR,
    transactionCount: async () => 7n,
    blockNumber: async () => 0n,
  };
  const previous = initAuctionDeployState("community");
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous,
    onLink: async () => {
      throw new Error("publish timed out");
    },
  });
  const state = fold(auctionDeployReducer, previous, actions);
  assert.equal(state.phase, "paused");
  assert.equal(state.failure.stage, "link");
  assert.match(state.failure.reason, /publish timed out/);
  assert.equal(
    state.steps.executor.address,
    EXECUTOR_GOLDEN,
    "receipt address wins",
  );
  assert.deepEqual(retryPlan(state), {
    kind: "record",
    auctionAddress: AUCTION_ADDR,
  });
});

// ---------------------------------------------------------------------------
// Graduation readiness
// ---------------------------------------------------------------------------

// Custom-error selectors (`cast sig`) as a node reports them on a revert.
const REVERTS = {
  notGraduated: "0xc1c5eb4f", // NotGraduated(address)
  alreadyExecuted: "0x27307889", // AlreadyExecuted(address)
  other: "0x5a8e1bb8", // AuctionNotBound(address,address)
};

function readinessEffects(script) {
  return {
    call: async ({ to, data }) => {
      const selector = data.slice(0, 10);
      if (selector === "0x69d4d0f1") {
        // A simulation of executeGraduation(auction), sent to the executor.
        assert.equal(to, EXECUTOR_GOLDEN);
        const outcome = script.simulate ?? "ok";
        if (outcome === "ok") return "0x";
        throw new Error(
          `execution reverted: custom error ${REVERTS[outcome]}: ${"0".repeat(64)}`,
        );
      }
      assert.equal(to, AUCTION_ADDR);
      if (selector === SELECTOR_FUNDS_RECIPIENT) return addrWord(script.funds);
      if (selector === SELECTOR_TOKENS_RECIPIENT)
        return addrWord(script.tokens);
      if (selector === SELECTOR_IS_GRADUATED)
        return uintWord(script.graduated ? 1n : 0n);
      if (selector === SELECTOR_LBP_INITIALIZATION_PARAMS) {
        if (script.paramsRevert) throw new Error("execution reverted");
        return rawWords(uintWord(7n), uintWord(8n), uintWord(9n));
      }
      throw new Error(`unexpected call ${selector}`);
    },
    blockNumber: async () => {
      if (script.blockError) throw new Error("rpc down");
      return script.block;
    },
  };
}

test("checkGraduationReadiness renders the contract's actual gates", async () => {
  const ready = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: true,
      paramsRevert: false,
      block: 1011n,
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.finalizesOnExecute, false);
  assert.deepEqual(ready.params, {
    initialPriceX96: 7n,
    tokensSold: 8n,
    currencyRaised: 9n,
  });
  assert.equal(ready.executor, EXECUTOR_GOLDEN);

  const finalizes = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: true,
      paramsRevert: true,
      block: 1011n,
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(finalizes.status, "ready");
  assert.equal(finalizes.finalizesOnExecute, true);
  assert.match(finalizes.message, /would succeed/);

  const early = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: true,
      paramsRevert: true,
      block: 1005n,
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(early.status, "running");

  const running = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: false,
      paramsRevert: true,
      block: 1005n,
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(running.status, "running");
  assert.match(running.message, /Auction still running/);

  const missed = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: false,
      paramsRevert: true,
      block: 1011n,
      simulate: "notGraduated",
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(missed.status, "threshold-missed");
  assert.match(missed.message, /Threshold not met — refunds path/);
});

test("an auction that cleared its threshold is ready even before anyone checkpoints the end block", async () => {
  // REGRESSION. `isGraduated()` only reflects the LAST checkpoint, so right after
  // the end block a successful auction reads isGraduated=false and (with the
  // params view still reverting) used to be reported as "threshold missed" — the
  // founder was told there was nothing to graduate. The simulation of the real
  // call (which checkpoints first) is what decides.
  const readiness = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: false,
      paramsRevert: true,
      block: 1011n,
      simulate: "ok",
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.finalizesOnExecute, true);
});

test("a graduation that already ran is never offered again, even though its params stay readable", async () => {
  // REGRESSION. After executeGraduation the auction stays graduated and its
  // lbpInitializationParams() stay readable, so the params-readable branch said
  // "ready" for a launch that had already been graduated (the call would revert
  // AlreadyExecuted). A founder returning to the page saw an Execute button.
  const readiness = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: true,
      paramsRevert: false,
      block: 1011n,
      simulate: "alreadyExecuted",
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(readiness.status, "already-graduated");
});

test("graduation readiness classifies the simulated revert, and never simulates a running auction", async () => {
  const already = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: true,
      paramsRevert: true,
      block: 1011n,
      simulate: "alreadyExecuted",
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(already.status, "already-graduated");

  const blocked = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: EXECUTOR_GOLDEN,
      graduated: false,
      paramsRevert: true,
      block: 1011n,
      simulate: "other",
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /would revert right now/);
  assert.ok(blocked.message.includes(REVERTS.other));

  // Before the end there is nothing to simulate: a simulation there would only
  // ever report "not graduated" for a perfectly healthy auction.
  const effects = readinessEffects({
    funds: EXECUTOR_GOLDEN,
    tokens: EXECUTOR_GOLDEN,
    graduated: false,
    paramsRevert: true,
    block: 1005n,
  });
  const inner = effects.call;
  effects.call = async (input) => {
    assert.notEqual(
      input.data.slice(0, 10),
      "0x69d4d0f1",
      "simulated too early",
    );
    return inner(input);
  };
  const running = await checkGraduationReadiness({
    effects,
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(running.status, "running");
});

test("checkGraduationReadiness names misconfigured recipients and failed reads", async () => {
  const misconfigured = await checkGraduationReadiness({
    effects: readinessEffects({
      funds: EXECUTOR_GOLDEN,
      tokens: DEPLOYER,
      graduated: true,
      paramsRevert: false,
      block: 1011n,
    }),
    auction: AUCTION_ADDR,
    endBlock: 1010,
  });
  assert.equal(misconfigured.status, "misconfigured");
  assert.match(misconfigured.message, /executeGraduation requires BOTH/);

  await assert.rejects(
    () =>
      checkGraduationReadiness({
        effects: {
          ...readinessEffects({
            funds: EXECUTOR_GOLDEN,
            tokens: EXECUTOR_GOLDEN,
            graduated: true,
            paramsRevert: false,
            block: 1n,
          }),
          call: async () => {
            throw new Error("rpc down");
          },
        },
        auction: AUCTION_ADDR,
        endBlock: 1010,
      }),
    (error) => {
      assert.equal(error.name, "GraduationCheckError");
      assert.equal(error.stage, "recipients");
      return true;
    },
  );

  await assert.rejects(
    () =>
      checkGraduationReadiness({
        effects: readinessEffects({
          funds: EXECUTOR_GOLDEN,
          tokens: EXECUTOR_GOLDEN,
          graduated: false,
          paramsRevert: true,
          block: 1n,
          blockError: true,
        }),
        auction: AUCTION_ADDR,
        endBlock: 1010,
      }),
    (error) => {
      assert.equal(error.name, "GraduationCheckError");
      assert.equal(error.stage, "block");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Graduation reducer + runner
// ---------------------------------------------------------------------------

test("graduation reducer distinguishes money failure from mirror failure", () => {
  const order = GRADUATION_STEPS.map((s) => s.id);
  let state = graduationFlowReducer(initialGraduationState(), {
    type: "reset",
    order,
  });
  assert.equal(state.phase, "ready");
  assert.deepEqual(graduationRetryPlan(state), null);

  // Mirror failure BEFORE any tx lands is a plain failure (nothing to bind).
  state = graduationFlowReducer(state, {
    type: "step-failed",
    step: "mirrorSweep",
    message: "x",
  });
  assert.equal(state.phase, "failed");
  assert.deepEqual(graduationRetryPlan(state), { kind: "mirror" });

  // With the money landed, a mirror failure is mirror-only retryable.
  let landed = graduationFlowReducer(
    graduationFlowReducer(initialGraduationState(), { type: "reset", order }),
    { type: "step-start", step: "execute" },
  );
  landed = graduationFlowReducer(landed, {
    type: "step-done",
    step: "execute",
    txHash: TX1,
  });
  assert.equal(landed.graduationTxHash, TX1);
  landed = graduationFlowReducer(landed, {
    type: "step-failed",
    step: "mirrorLock",
    message: "publish failed",
  });
  assert.equal(landed.phase, "mirrorFailed");
  assert.deepEqual(graduationRetryPlan(landed), { kind: "mirror" });

  // Money-step failure stays "failed" + execute retry.
  const moneyFailed = graduationFlowReducer(
    graduationFlowReducer(initialGraduationState(), { type: "reset", order }),
    { type: "step-failed", step: "execute", message: "reverted" },
  );
  assert.equal(moneyFailed.phase, "failed");
  assert.deepEqual(graduationRetryPlan(moneyFailed), { kind: "execute" });

  // A readiness check failure is re-checked, never re-sent.
  const checkFailed = graduationFlowReducer(initialGraduationState(), {
    type: "check_failed",
    message: "rpc down",
  });
  assert.deepEqual(graduationRetryPlan(checkFailed), { kind: "check" });

  const checking = graduationFlowReducer(initialGraduationState(), {
    type: "check_start",
  });
  assert.equal(checking.phase, "checking");
});

function graduationDeps(script) {
  const calls = { sends: [], reads: 0, publishes: [] };
  return {
    calls,
    deps: {
      send: async (call) => {
        calls.sends.push(call);
        if (script.sendThrows) throw new Error("transport died");
        return successReceipt(TX1);
      },
      readGraduation: async () => {
        calls.reads += 1;
        return calls.reads === 1 ? script.before : script.after;
      },
      publishReceipt: async (kind, parts) => {
        if (script.failPublish === kind)
          throw new Error("mirror publish failed");
        calls.publishes.push({ kind, parts });
      },
    },
  };
}

const GRADUATION_RECORD = {
  initialPriceX96: 7n,
  tokensSold: 8n,
  currencyRaised: 9n,
  reserveEscrow: 4n,
  treasuryShare: 5n,
  unsoldTokens: 6n,
  tokenMasterPool: "0x0000000000000000000000000000000000000000",
  executed: true,
};

const EXECUTION = {
  auction: AUCTION_ADDR,
  executor: EXECUTOR_GOLDEN,
  call: { to: EXECUTOR_GOLDEN, data: "0x69d4d0f1", value: "0x0" },
};

test("runGraduationFlow executes once, then publishes both bound receipts", async () => {
  const order = GRADUATION_STEPS.map((s) => s.id);
  const { actions, dispatch } = collectingDispatch();
  const { calls, deps } = graduationDeps({
    before: { ...GRADUATION_RECORD, executed: false },
    after: GRADUATION_RECORD,
  });
  await runGraduationFlow(EXECUTION, deps, dispatch, {
    completed: new Set(),
    graduationTxHash: null,
  });
  const state = fold(
    graduationFlowReducer,
    graduationFlowReducer(initialGraduationState(), { type: "reset", order }),
    actions,
  );
  assert.equal(state.phase, "done");
  assert.equal(state.graduationTxHash, TX1);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.reads, 2, "guard read + receipt-amount read");
  assert.deepEqual(
    calls.publishes.map((p) => p.kind),
    ["sweep", "lock"],
  );
  for (const { parts } of calls.publishes) {
    assert.deepEqual(parts.extraTags[1], ["tx", TX1]);
  }
  assert.deepEqual(calls.publishes[0].parts.content, {
    table: "sweep",
    auction: AUCTION_ADDR,
    currencyRaised: "9",
    treasuryShare: "5",
    unsoldTokens: "6",
  });
  assert.deepEqual(calls.publishes[1].parts.content, {
    table: "lock",
    auction: AUCTION_ADDR,
    reserveEscrow: "4",
  });
});

test("runGraduationFlow mirror failure retries the mirror only — never the money action", async () => {
  const order = GRADUATION_STEPS.map((s) => s.id);
  const { actions, dispatch } = collectingDispatch();
  const { calls, deps } = graduationDeps({
    before: { ...GRADUATION_RECORD, executed: false },
    after: GRADUATION_RECORD,
    failPublish: "sweep",
  });
  await runGraduationFlow(EXECUTION, deps, dispatch, {
    completed: new Set(),
    graduationTxHash: null,
  });
  const failedState = fold(
    graduationFlowReducer,
    graduationFlowReducer(initialGraduationState(), { type: "reset", order }),
    actions,
  );
  assert.equal(failedState.phase, "mirrorFailed");
  assert.match(failedState.errorMessage, /mirror publish failed/);
  assert.match(failedState.errorMessage, /Publish sweep receipt failed/);

  // Mirror-only retry: the money call is not re-sent.
  deps.publishReceipt = async (kind, parts) => {
    calls.publishes.push({ kind, parts });
  };
  const second = collectingDispatch();
  await runGraduationFlow(EXECUTION, deps, second.dispatch, {
    completed: new Set(order.filter((id) => failedState.steps[id] === "done")),
    graduationTxHash: failedState.graduationTxHash,
  });
  assert.equal(calls.sends.length, 1, "executeGraduation sent exactly once");
  assert.deepEqual(
    calls.publishes.map((p) => p.kind),
    ["sweep", "lock"],
  );
});

test("runGraduationFlow never re-sends after an unknown outcome that landed", async () => {
  const order = GRADUATION_STEPS.map((s) => s.id);
  const { actions, dispatch } = collectingDispatch();
  const { calls, deps } = graduationDeps({
    before: { ...GRADUATION_RECORD, executed: false },
    after: GRADUATION_RECORD,
    sendThrows: true,
  });
  await runGraduationFlow(EXECUTION, deps, dispatch, {
    completed: new Set(),
    graduationTxHash: null,
  });
  const failedState = fold(
    graduationFlowReducer,
    graduationFlowReducer(initialGraduationState(), { type: "reset", order }),
    actions,
  );
  assert.equal(failedState.phase, "failed");
  assert.match(failedState.errorMessage, /may or may not have been broadcast/);

  // Retry: the guard read now shows executed — the tx landed without a receipt.
  const second = collectingDispatch();
  calls.reads = 1; // next read returns `after` (executed)
  await runGraduationFlow(EXECUTION, deps, second.dispatch, {
    completed: new Set(order.filter((id) => failedState.steps[id] === "done")),
    graduationTxHash: failedState.graduationTxHash,
  });
  assert.equal(calls.sends.length, 1, "the money action was never re-sent");
  const resumed = fold(graduationFlowReducer, failedState, second.actions);
  assert.equal(resumed.steps.execute, "done");
  // Without a confirmed hash the receipts cannot bind (the relay requires
  // exactly one `tx` tag) — that failure is named, not faked.
  assert.equal(resumed.phase, "failed");
  assert.match(resumed.errorMessage, /no confirmed transaction hash/);
  assert.equal(calls.publishes.length, 0);
});
