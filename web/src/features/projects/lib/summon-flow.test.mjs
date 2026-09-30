// Summon flow semantics + sender calldata parity.
//
// Same contract as `ragequit-flow.test.mjs` (its fixture block is copied: a
// test file owns its own fixtures here): failures name their step, a
// mirror-only failure never re-sends the money, an unknown outcome is a
// terminal state, and the composed summon bytes reach BOTH senders
// byte-identically — the sender swap may change only the wire wrapper.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSponsoredSender,
  encodeExecuteBatchCallData,
  encodeExecuteSingleCallData,
  PASSKEY_CREDENTIAL_STORAGE_KEY,
} from "../../identity/lib/sponsoredSender.ts";
import { createInjectedWalletSender } from "../../launchpad/lib/wallet-sender.ts";
import {
  buildSummonTx,
  encodeSummonCalldata,
  SHARES_PER_PERCENT,
  summonSalt,
} from "./summon-composer.ts";
import {
  buildSummonPlan,
  completedSummonSteps,
  initialSummonFlowState,
  remainingSummonSteps,
  resumeSummonFromState,
  runSummonFlow,
  senderSummonDeps,
  SUMMON_STEP_LABELS,
  summonFlowReducer,
} from "./summon-flow.ts";

// ------------------------------------------------------------- fixtures ----

const SUMMONER = `0x${"50".repeat(20)}`;
const HOLDER = `0x${"11".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const KERNEL_ADDR = `0x${"33".repeat(20)}`;
const OWNER = `0x${"22".repeat(20)}`;
const CHAIN_ID = 11155111;
const CONFIG = { chainId: CHAIN_ID, rpcUrl: "http://rpc.invalid" };
const R1_HEX = `04${"11".repeat(32)}${"22".repeat(32)}`;
const CREDENTIAL_ID = "test-credential-id";

const TX_HASH = `0x${"11".repeat(32)}`;

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function seedPasskeyStorage() {
  globalThis.localStorage = fakeStorage({
    [PASSKEY_CREDENTIAL_STORAGE_KEY]: CREDENTIAL_ID,
    "buzz.passkey.salt": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ",
    "buzz.passkey.pubkey": "npub1test",
    "buzz.passkey.mode": "prf",
    "buzz.passkey.r1": R1_HEX,
  });
}

function clearPasskeyStorage() {
  globalThis.localStorage = fakeStorage({});
}

function fakeChainRpc() {
  return {
    ethCall: async () => `0x${"00".repeat(12)}${KERNEL_ADDR.slice(2)}`,
    getCode: async () => "0x",
    latestBaseFeePerGas: async () => 1_000_000_000n,
  };
}

function fakeZerodev() {
  return {
    projectId: "test-project",
    apiKey: "test-api-key",
    chainId: CHAIN_ID,
  };
}

function fakeUserOpResult(txHash) {
  return {
    txHash,
    blockNumber: "1",
    userOpHash: `0x${"ab".repeat(32)}`,
    sender: KERNEL_ADDR,
    gasUsed: "21000",
    paymaster: `0x${"cd".repeat(20)}`,
    deployed: false,
    success: true,
  };
}

function capturingDeps() {
  const requests = [];
  let txCounter = 0;
  return {
    requests,
    deps: {
      rpc: fakeChainRpc(),
      zerodev: fakeZerodev(),
      getSender: async () => KERNEL_ADDR,
      sendUserOp: async (request) => {
        requests.push(request);
        txCounter += 1;
        return fakeUserOpResult(
          `0x${txCounter.toString(16).padStart(64, "0")}`,
        );
      },
    },
  };
}

function collect() {
  const actions = [];
  return { actions, dispatch: (action) => actions.push(action) };
}

const summonData = () =>
  encodeSummonCalldata({
    orgName: "Nebula",
    orgSymbol: "NEB",
    orgURI: "",
    quorumBps: 500,
    ragequittable: true,
    renderer: `0x${"00".repeat(20)}`,
    salt: summonSalt("nebula"),
    initHolders: [HOLDER],
    initShares: [40n * SHARES_PER_PERCENT],
  });

const summonTx = () => buildSummonTx(SUMMONER, summonData());

/** Scripted `send`: returns the outcomes in order, and counts the calls. */
function scriptedSend(outcomes) {
  const calls = [];
  return {
    calls,
    async send(tx) {
      calls.push(tx);
      const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      return { txHash: TX_HASH, ...next };
    },
  };
}

// ------------------------------------------------------------ semantics ----

test("the step vocabulary is the closed pair {send, mirror} with labels", () => {
  assert.deepEqual(Object.keys(SUMMON_STEP_LABELS).sort(), ["mirror", "send"]);
  const state = summonFlowReducer(initialSummonFlowState(), {
    type: "reset",
    order: ["send"],
  });
  assert.equal(state.steps.mirror, "skipped");
  assert.deepEqual([...completedSummonSteps(state)], []);
  assert.equal(state.reconcile, false);
});

test("happy path: send then mirror, both receipts recorded", async () => {
  const plan = buildSummonPlan({ buildTx: summonTx });
  assert.deepEqual(plan.order, ["send", "mirror"]);

  const publishes = [];
  const send = scriptedSend([
    { status: "success", dao: DAO, blockNumber: "0x1" },
  ]);
  const { dispatch } = collect();
  let state = summonFlowReducer(initialSummonFlowState(), {
    type: "reset",
    order: plan.order,
  });
  const reducer = (action) => {
    dispatch(action);
    state = summonFlowReducer(state, action);
  };
  await runSummonFlow(
    plan,
    {
      send: send.send,
      publishReceipt: async (receipt) => {
        publishes.push(receipt);
      },
    },
    reducer,
  );
  assert.equal(state.phase, "done");
  assert.equal(state.steps.send, "done");
  assert.equal(state.steps.mirror, "done");
  assert.equal(state.receipts.send.dao, DAO);
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].txHash, TX_HASH);
  assert.deepEqual(
    [...remainingSummonSteps(state)],
    [],
    "a completed attempt leaves nothing to retry",
  );
});

test("a mined revert fails the send step as data — nothing is recorded", async () => {
  const plan = buildSummonPlan({ buildTx: summonTx });
  // First attempt reverted (nothing landed); the retry mines and confirms.
  const send = scriptedSend([
    { status: "reverted", dao: null, blockNumber: "0x1" },
    { status: "success", dao: DAO, blockNumber: "0x2" },
  ]);
  let published = 0;
  let state = summonFlowReducer(initialSummonFlowState(), {
    type: "reset",
    order: plan.order,
  });
  const reducer = (action) => {
    state = summonFlowReducer(state, action);
  };
  await runSummonFlow(
    plan,
    {
      send: send.send,
      publishReceipt: async () => {
        published += 1;
      },
    },
    reducer,
  );
  assert.equal(state.phase, "failed");
  assert.equal(state.failedStep, "send");
  assert.match(state.errorMessage, /Create the DAO onchain .* failed/);
  assert.match(state.errorMessage, /reverted onchain \(tx 0x11/);
  assert.equal(published, 0, "a reverted summon is never recorded as done");
  assert.equal(state.reconcile, false, "a revert is safe to retry");

  // Retry: the send may run again (nothing landed), and only then the record.
  const retry = resumeSummonFromState(state);
  assert.deepEqual([...retry.completed], []);
  assert.equal(retry.reconcile, false);
  await runSummonFlow(
    plan,
    {
      send: send.send,
      publishReceipt: async () => {
        published += 1;
      },
    },
    reducer,
    retry,
  );
  assert.equal(send.calls.length, 2, "a reverted summon may be re-sent");
  assert.equal(published, 1);
  assert.equal(state.phase, "done");
});

test("an unknown outcome is terminal: retry never re-sends", async () => {
  const plan = buildSummonPlan({ buildTx: summonTx });
  const send = scriptedSend([
    { status: "unknown", dao: null, blockNumber: null, reason: "rpc down" },
  ]);
  let state = summonFlowReducer(initialSummonFlowState(), {
    type: "reset",
    order: plan.order,
  });
  const reducer = (action) => {
    state = summonFlowReducer(state, action);
  };
  const deps = { send: send.send, publishReceipt: async () => {} };
  await runSummonFlow(plan, deps, reducer);
  assert.equal(state.phase, "failed");
  assert.equal(state.failedStep, "send");
  assert.match(state.errorMessage, /outcome is unknown after polling/);
  assert.match(state.errorMessage, /rpc down/);
  assert.match(state.errorMessage, /check the chain before retrying/);
  assert.equal(state.reconcile, true);
  assert.equal(
    state.receipts.send.txHash,
    TX_HASH,
    "the hash is kept for the user",
  );

  const retry = resumeSummonFromState(state);
  assert.equal(retry.reconcile, true);
  await runSummonFlow(plan, deps, reducer, retry);
  assert.equal(send.calls.length, 1, "the unconfirmed summon is NOT re-sent");
  assert.equal(state.phase, "failed", "the flow stays in its terminal state");
  assert.equal(state.failedStep, "send");
  assert.match(state.errorMessage, /unknown after polling/);
});

test("a mirror failure keeps the summon and retries without re-sending", async () => {
  const plan = buildSummonPlan({ buildTx: summonTx });
  const send = scriptedSend([
    { status: "success", dao: DAO, blockNumber: "0x1" },
  ]);
  let attempts = 0;
  let state = summonFlowReducer(initialSummonFlowState(), {
    type: "reset",
    order: plan.order,
  });
  const reducer = (action) => {
    state = summonFlowReducer(state, action);
  };
  const deps = {
    send: send.send,
    publishReceipt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay 500");
    },
  };
  await runSummonFlow(plan, deps, reducer);
  assert.equal(state.steps.send, "done", "the money step is not rolled back");
  assert.equal(state.steps.mirror, "failed");
  assert.equal(state.failedStep, "mirror");
  assert.match(state.errorMessage, /relay 500/);
  assert.match(
    state.errorMessage,
    /retry records it without re-sending/,
    "the failure text names the recovery path",
  );
  assert.equal(state.receipts.send.dao, DAO, "the summon receipt survives");

  const retry = resumeSummonFromState(state);
  assert.deepEqual([...retry.completed], ["send"], "send is not retried");
  await runSummonFlow(plan, deps, reducer, retry);
  assert.equal(send.calls.length, 1, "retry re-sends nothing");
  assert.equal(attempts, 2, "and records the receipt");
  assert.equal(state.phase, "done");
  assert.equal(state.steps.mirror, "done");
});

test("remaining steps are only the undone ones", () => {
  let state = initialSummonFlowState();
  const reducer = (action) => {
    state = summonFlowReducer(state, action);
  };
  reducer({ type: "reset", order: ["send", "mirror"] });
  reducer({ type: "step-start", step: "send" });
  reducer({ type: "step-done", step: "send" });
  assert.deepEqual([...remainingSummonSteps(state)], ["mirror"]);
  reducer({ type: "step-done", step: "mirror" });
  assert.deepEqual([...remainingSummonSteps(state)], []);
});

// ----------------------------------------------------- sender binding ------

test("senderSummonDeps sends the composed bytes and reads the outcome", async () => {
  const wire = [];
  const passthrough = {
    async sendCalls(calls) {
      wire.push(...calls);
      return { txHash: TX_HASH, receipts: [] };
    },
  };
  const deps = senderSummonDeps(
    passthrough,
    async (hash) => ({
      status: "success",
      dao: DAO,
      blockNumber: "0x5",
      seenHash: hash,
    }),
    async () => {},
  );
  const receipt = await deps.send(summonTx());
  assert.deepEqual(wire, [{ to: SUMMONER, data: summonData(), value: "0x0" }]);
  assert.deepEqual(receipt, {
    txHash: TX_HASH,
    status: "success",
    dao: DAO,
    blockNumber: "0x5",
  });
});

// ------------------------------------- composer/sender calldata parity ----

const secondSummonTx = () =>
  buildSummonTx(
    SUMMONER,
    encodeSummonCalldata({
      orgName: "Nebula Ops",
      orgSymbol: "NEBO",
      orgURI: "",
      quorumBps: 750,
      ragequittable: true,
      renderer: `0x${"00".repeat(20)}`,
      salt: summonSalt("nebula-ops"),
      initHolders: [HOLDER],
      initShares: [60n * SHARES_PER_PERCENT],
    }),
  );

test("the summon call reaches both senders byte-identically", async () => {
  const composed = [summonTx(), secondSummonTx()];

  // Injected-wallet path: capture at the eth_sendTransaction wire.
  const walletWire = [];
  const walletSender = createInjectedWalletSender({
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_sendTransaction") {
        walletWire.push(params[0]);
        return TX_HASH;
      }
      throw new Error(`unexpected wallet method ${method}`);
    },
  });
  await walletSender.sendCalls(composed);
  assert.deepEqual(
    walletWire.map(({ to, value, data }) => ({ to, value, data })),
    composed,
    "the wallet receives the composed summon byte-identically",
  );

  // Sponsored path: capture at the kernel033 UserOp wire.
  seedPasskeyStorage();
  try {
    const perCall = capturingDeps();
    await createSponsoredSender(
      { ...CONFIG, batching: "per-call" },
      perCall.deps,
    ).sendCalls(composed);
    assert.equal(perCall.requests.length, walletWire.length);
    perCall.requests.forEach((request, i) => {
      assert.equal(
        request.callData,
        encodeExecuteSingleCallData(walletWire[i]),
        `UserOp ${i} carries the same summon bytes`,
      );
    });

    const batched = capturingDeps();
    await createSponsoredSender(CONFIG, batched.deps).sendCalls(composed);
    assert.equal(batched.requests.length, 1);
    assert.equal(
      batched.requests[0].callData,
      encodeExecuteBatchCallData(walletWire),
      "the batched UserOp encodes the very call the wallet sent",
    );
  } finally {
    clearPasskeyStorage();
  }
});
