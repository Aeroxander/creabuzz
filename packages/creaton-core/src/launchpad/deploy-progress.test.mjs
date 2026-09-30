import assert from "node:assert/strict";
import test from "node:test";

import {
  auctionDeployReducer,
  initAuctionDeployState,
  runAuctionDeploy,
} from "./auctionFlow.ts";
import {
  deployProgressFingerprint,
  loadDeployProgress,
  makeGenerationFence,
  saveDeployProgress,
  seedAuctionDeployState,
  settleIfCurrent,
} from "./deploy-progress.ts";

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
const EXECUTOR_ADDR = "0x3333333333333333333333333333333333333333";
const AUCTION_ADDR = "0x5555555555555555555555555555555555555555";
const OTHER_AUCTION = "0x7777777777777777777777777777777777777777";
const TX1 = `0x${"11".repeat(32)}`;

const addrWord = (address) =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

function fold(reducer, init, actions) {
  return actions.reduce(reducer, init);
}

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

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

/** The state a session crashed mid-deploy leaves behind (via the dispatch
 * seam's persistence): the executor CREATE landed, the auction was predicted
 * but its factory send never confirmed. */
function crashedState() {
  return fold(auctionDeployReducer, initAuctionDeployState("community"), [
    { type: "begin", mode: "fresh" },
    { type: "prepared", auctionAddress: null },
    { type: "step_started", step: "executor" },
    {
      type: "step_done",
      step: "executor",
      txHash: TX1,
      address: EXECUTOR_ADDR,
      alreadyDeployed: false,
    },
    { type: "step_started", step: "auction" },
    { type: "step_address", step: "auction", address: AUCTION_ADDR },
  ]);
}

test("deploy progress persists addresses + tx hashes keyed by launch id and plan", () => {
  const storage = fakeStorage();
  const fingerprint = deployProgressFingerprint(PLAN);
  saveDeployProgress("launch-1", fingerprint, crashedState(), storage);

  const loaded = loadDeployProgress("launch-1", fingerprint, storage);
  assert.ok(loaded, "progress round-trips");
  assert.equal(loaded.steps.executor.txHash, TX1, "receipt is durable");
  assert.equal(loaded.steps.executor.address, EXECUTOR_ADDR);
  assert.equal(
    loaded.steps.auction.address,
    AUCTION_ADDR,
    "prediction is durable",
  );
  assert.equal(loadDeployProgress("other-launch", fingerprint, storage), null);
  // A relaunch drops the sale window (and links) — the dead deployment's
  // progress must not fence the new deploy.
  const relaunched = { ...PLAN, startBlock: undefined, endBlock: undefined };
  assert.equal(
    loadDeployProgress(
      "launch-1",
      deployProgressFingerprint(relaunched),
      storage,
    ),
    null,
    "progress is plan-scoped",
  );
});

test("reload/resume: seeded progress engages the codeAt guards — zero duplicate sends", async () => {
  const storage = fakeStorage();
  const fingerprint = deployProgressFingerprint(PLAN);
  saveDeployProgress("launch-1", fingerprint, crashedState(), storage);

  // Fresh mount seeds `previous` exactly as the hook's reducer initializer.
  const previous = seedAuctionDeployState(
    "community",
    loadDeployProgress("launch-1", fingerprint, storage),
  );
  assert.equal(previous.steps.executor.address, EXECUTOR_ADDR);
  assert.equal(previous.steps.auction.address, AUCTION_ADDR);
  // A step interrupted mid-flight is retryable, not stuck "running".
  const stuck = seedAuctionDeployState("community", {
    ...crashedState(),
    steps: {
      ...crashedState().steps,
      executor: {
        status: "running",
        txHash: null,
        address: EXECUTOR_ADDR,
        alreadyDeployed: false,
      },
    },
    version: 1,
    fingerprint,
  });
  assert.equal(stuck.steps.executor.status, "failed");
  assert.equal(stuck.steps.executor.address, EXECUTOR_ADDR);

  const { actions, dispatch } = collectingDispatch();
  const sends = [];
  const links = [];
  const effects = {
    call: async () => addrWord(AUCTION_ADDR),
    send: async (call) => {
      sends.push(call);
      return successReceipt(TX1);
    },
    // Everything the resumed run probes already exists onchain.
    codeAt: async (address) =>
      address === EXECUTOR_ADDR || address === AUCTION_ADDR,
    // The wallet has moved on since the crash: re-deriving predictions from
    // this nonce would target DIFFERENT addresses than the persisted ones.
    transactionCount: async () => 9n,
    blockNumber: async () => 0n,
  };
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

  assert.equal(
    sends.filter((call) => call.to === undefined).length,
    0,
    "zero CREATE re-sends",
  );
  assert.equal(
    sends.filter((call) => call.to === FACTORY).length,
    0,
    "zero factory re-sends",
  );
  assert.deepEqual(
    links,
    [{ auction: AUCTION_ADDR }],
    "the known auction links",
  );
  // Fold onto the SEEDED state — the resumed run dispatches nothing for the
  // steps the guards satisfied (that is the point), so folding onto a fresh
  // init would lose their completions.
  const state = fold(auctionDeployReducer, previous, actions);
  assert.equal(state.phase, "success");
  assert.equal(state.steps.executor.status, "done");
  assert.equal(state.steps.executor.address, EXECUTOR_ADDR);
  assert.equal(state.steps.auction.address, AUCTION_ADDR);
});

test("re-link mismatch refuses before any effect, with a visible way out", async () => {
  const { actions, dispatch } = collectingDispatch();
  const links = [];
  let effectCalls = 0;
  const effects = {
    call: async () => {
      effectCalls += 1;
      return addrWord(AUCTION_ADDR);
    },
    send: async () => {
      effectCalls += 1;
      return successReceipt(TX1);
    },
    codeAt: async () => {
      effectCalls += 1;
      return false;
    },
    transactionCount: async () => {
      effectCalls += 1;
      return 7n;
    },
    blockNumber: async () => {
      effectCalls += 1;
      return 0n;
    },
  };
  // An earlier attempt predicted AUCTION_ADDR for this launch…
  const previous = fold(
    auctionDeployReducer,
    initAuctionDeployState("community"),
    [
      { type: "begin", mode: "fresh" },
      { type: "step_address", step: "auction", address: AUCTION_ADDR },
    ],
  );
  // …but the launch record already carries a different auction.
  await runAuctionDeploy({
    effects,
    plan: PLAN,
    deployer: DEPLOYER,
    factory: FACTORY,
    dispatch,
    mode: "fresh",
    previous,
    expectedAuction: OTHER_AUCTION,
    onLink: async (input) => {
      links.push(input);
    },
  });

  assert.equal(effectCalls, 0, "no effects called");
  assert.deepEqual(links, [], "nothing was linked");
  const state = fold(
    auctionDeployReducer,
    initAuctionDeployState("community"),
    actions,
  );
  assert.equal(state.failure?.stage, "step");
  const reason = state.failure?.reason ?? "";
  assert.match(reason, /no transaction was sent/i);
  assert.ok(reason.includes(OTHER_AUCTION), "names the recorded auction");
  assert.ok(reason.includes(AUCTION_ADDR), "names the conflicting one");
  assert.ok(
    /reload|relaunch/i.test(reason),
    "explains how to proceed (no dead end)",
  );
});

test("a stale readiness result never overwrites a newer one (generation fence)", () => {
  const fence = makeGenerationFence();
  const applied = [];
  const first = fence.next();
  const second = fence.next();
  assert.equal(fence.isCurrent(first), false);
  assert.equal(fence.isCurrent(second), true);
  // The slower earlier check settles last — and must not dispatch.
  settleIfCurrent(fence, second, () => applied.push("second"));
  settleIfCurrent(fence, first, () => applied.push("first"));
  assert.deepEqual(applied, ["second"]);
  // A lone check settles normally.
  const solo = fence.next();
  settleIfCurrent(fence, solo, () => applied.push("solo"));
  assert.deepEqual(applied, ["second", "solo"]);
});
