// Ragequit flow semantics + composer/sender calldata parity.
//
// The reducer/orchestrator scenarios follow the established money-action
// contract of `exit-flow.ts` (itself a port of desktop `bidHooks.ts`):
// failures name their step, a mirror-only failure never re-sends the money,
// and retry runs only the remaining steps. The parity block mirrors
// `exit-claim.test.mjs`'s "Composer/sender calldata parity" section: the same
// composed calls must reach BOTH adapters byte-identically — the sender swap
// may change only the wire wrapper, never a calldata byte.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSponsoredSender,
  encodeExecuteBatchCallData,
  encodeExecuteSingleCallData,
  PASSKEY_CREDENTIAL_STORAGE_KEY,
} from "../../identity/lib/sponsoredSender.ts";
import { createInjectedWalletSender } from "./wallet-sender.ts";
import {
  buildRagequitTx,
  encodeRagequitCalldata,
  ETH_TOKEN,
} from "./ragequit-tx.ts";
import {
  buildRagequitPlan,
  completedRagequitSteps,
  initialRagequitFlowState,
  RAGEQUIT_STEP_LABELS,
  ragequitFlowReducer,
  remainingRagequitSteps,
  resumeRagequitFromState,
  runRagequitFlow,
  senderRagequitDeps,
} from "./ragequit-flow.ts";

// ------------------------------------------------------------- fixtures ----

const DAO = `0x${"da".repeat(20)}`;
const OWNER = `0x${"22".repeat(20)}`;
const KERNEL_ADDR = `0x${"33".repeat(20)}`;
const CHAIN_ID = 11155111;
const CONFIG = { chainId: CHAIN_ID, rpcUrl: "http://rpc.invalid" };
const R1_HEX = `04${"11".repeat(32)}${"22".repeat(32)}`;
const CREDENTIAL_ID = "test-credential-id";

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

function receipt(txHash) {
  return { txHash, status: "success" };
}

function collect() {
  const actions = [];
  return { actions, dispatch: (a) => actions.push(a) };
}

const burnTx = () =>
  buildRagequitTx(DAO, {
    tokens: [ETH_TOKEN],
    sharesToBurn: 5n,
    lootToBurn: 0n,
    forbidden: [],
  });

// ------------------------------------------------------------ semantics ----

test("the reducer plans exit then mirror and closes on both", () => {
  const plan = buildRagequitPlan({ buildTx: burnTx });
  assert.deepEqual(plan.order, ["exit", "mirror"]);
  let state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: plan.order,
  });
  assert.deepEqual(state.steps, { exit: "pending", mirror: "pending" });

  state = ragequitFlowReducer(state, { type: "step-start", step: "exit" });
  state = ragequitFlowReducer(state, {
    type: "step-done",
    step: "exit",
    receipt: receipt(`0x${"ab".repeat(32)}`),
  });
  assert.equal(state.phase, "running", "the plan is not done until the mirror");

  state = ragequitFlowReducer(state, { type: "step-start", step: "mirror" });
  state = ragequitFlowReducer(state, { type: "step-done", step: "mirror" });
  assert.equal(state.phase, "done");
  assert.deepEqual(remainingRagequitSteps(state), []);
});

test("a mirror-only failure lands the money and retries ONLY the record", async () => {
  const sent = [];
  const published = [];
  let publishFails = true;
  const deps = {
    send: async (call) => {
      sent.push(call);
      return receipt(`0x${"cd".repeat(32)}`);
    },
    publishReceipt: async (r) => {
      published.push(r);
      if (publishFails) {
        publishFails = false;
        throw new Error("relay rejected the event");
      }
    },
  };
  const plan = buildRagequitPlan({ buildTx: burnTx });
  const rec = collect();
  let state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: plan.order,
  });
  await runRagequitFlow(plan, deps, (a) => {
    rec.actions.push(a);
    state = ragequitFlowReducer(state, a);
  });

  assert.equal(state.phase, "failed");
  assert.equal(state.failedStep, "mirror");
  assert.equal(sent.length, 1, "the money was sent exactly once");
  assert.equal(state.steps.exit, "done");
  assert.equal(state.steps.mirror, "failed");
  assert.match(state.errorMessage, /the exit itself landed/);
  assert.match(state.errorMessage, /without re-sending/);
  assert.equal(
    state.receipts.exit?.txHash,
    `0x${"cd".repeat(32)}`,
    "the exit receipt survives the mirror failure for raw-tx display",
  );

  // Retry: completed steps are never re-sent (Review-Proven Rule 5).
  const resume = resumeRagequitFromState(state);
  assert.deepEqual([...resume.completed], ["exit"]);
  const retryPlan = buildRagequitPlan({
    buildTx: () => {
      throw new Error("the burn must not be rebuilt on a mirror retry");
    },
    priorExitReceipt: state.receipts.exit,
  });
  published.length = 0;
  await runRagequitFlow(
    retryPlan,
    deps,
    (a) => {
      state = ragequitFlowReducer(state, a);
    },
    resume,
  );
  assert.equal(sent.length, 1, "retry must never re-send the burn");
  assert.equal(published.length, 1);
  assert.equal(published[0].txHash, `0x${"cd".repeat(32)}`);
  assert.equal(state.phase, "done");
});

test("a reverted exit is a named failed step — never a silent success", async () => {
  const deps = {
    send: async () => ({ txHash: `0x${"ee".repeat(32)}`, status: "reverted" }),
    publishReceipt: async () => {
      throw new Error("a reverted exit must not be recorded");
    },
  };
  const plan = buildRagequitPlan({ buildTx: burnTx });
  const rec = collect();
  let state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: plan.order,
  });
  await runRagequitFlow(plan, deps, (a) => {
    rec.actions.push(a);
    state = ragequitFlowReducer(state, a);
  });
  assert.equal(state.phase, "failed");
  assert.equal(state.failedStep, "exit");
  assert.match(state.errorMessage, /reverted onchain/);
  assert.equal(state.steps.mirror, "pending", "nothing was recorded");
});

test("a send exception names the exit step and stops the plan", async () => {
  const deps = {
    send: async () => {
      throw new Error("user rejected the request");
    },
    publishReceipt: async () => {
      throw new Error("must not run");
    },
  };
  const plan = buildRagequitPlan({ buildTx: burnTx });
  const rec = collect();
  let state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: plan.order,
  });
  await runRagequitFlow(plan, deps, (a) => {
    rec.actions.push(a);
    state = ragequitFlowReducer(state, a);
  });
  assert.equal(state.failedStep, "exit");
  assert.match(state.errorMessage, /user rejected the request/);
});

test("a compose failure is caught before anything is sent", async () => {
  const sent = [];
  const deps = {
    send: async (call) => {
      sent.push(call);
      return receipt(`0x${"01".repeat(32)}`);
    },
    publishReceipt: async () => {},
  };
  const plan = buildRagequitPlan({
    buildTx: () => {
      throw new Error("token list cannot be ragequit");
    },
  });
  const rec = collect();
  let state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: plan.order,
  });
  await runRagequitFlow(plan, deps, (a) => {
    rec.actions.push(a);
    state = ragequitFlowReducer(state, a);
  });
  assert.equal(sent.length, 0);
  assert.equal(state.failedStep, "exit");
  assert.match(state.errorMessage, /cannot be ragequit/);
});

test("the mirror step refuses to record without a confirmed exit", async () => {
  const deps = {
    send: async () => receipt(`0x${"02".repeat(32)}`),
    publishReceipt: async () => {
      throw new Error("must not record");
    },
  };
  const plan = buildRagequitPlan({
    buildTx: burnTx,
    priorExitReceipt: undefined,
  });
  // Run ONLY the mirror step (no prior receipt): a dishonest plan shape.
  const rec = collect();
  let state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: ["mirror"],
  });
  await runRagequitFlow(
    { calls: [{ step: "mirror" }] },
    deps,
    (a) => {
      rec.actions.push(a);
      state = ragequitFlowReducer(state, a);
    },
    { completed: new Set() },
  );
  assert.equal(state.failedStep, "mirror");
  assert.match(state.errorMessage, /no confirmed exit to record/);
  assert.equal(plan.order.length, 2);
});

test("the step vocabulary is the closed pair {exit, mirror} with labels", () => {
  assert.deepEqual(Object.keys(RAGEQUIT_STEP_LABELS).sort(), [
    "exit",
    "mirror",
  ]);
  const state = ragequitFlowReducer(initialRagequitFlowState(), {
    type: "reset",
    order: ["exit"],
  });
  assert.equal(state.steps.mirror, "skipped");
  assert.deepEqual([...completedRagequitSteps(state)], []);
});

// ------------------------------------- composer/sender calldata parity ----

test("the ragequit call reaches both senders byte-identically", async () => {
  const composed = [
    buildRagequitTx(DAO, {
      tokens: [ETH_TOKEN, `0x${"cc".repeat(20)}`],
      sharesToBurn: 5n,
      lootToBurn: 0n,
      forbidden: [],
    }),
    {
      to: DAO,
      value: "0x0",
      data: encodeRagequitCalldata({
        tokens: [ETH_TOKEN],
        sharesToBurn: 0n,
        lootToBurn: 7n,
      }),
    },
  ];

  // Injected-wallet path: capture at the eth_sendTransaction wire.
  const walletWire = [];
  const walletSender = createInjectedWalletSender({
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_sendTransaction") {
        walletWire.push(params[0]);
        return `0x${"11".repeat(32)}`;
      }
      throw new Error(`unexpected wallet method ${method}`);
    },
  });
  await walletSender.sendCalls(composed);
  assert.deepEqual(
    walletWire.map(({ to, value, data }) => ({ to, value, data })),
    composed,
    "the wallet receives the composed calls byte-identically, in order",
  );

  // Sponsored path: capture at the kernel033 UserOp wire (exit-claim.test.mjs
  // "call parity" pattern).
  seedPasskeyStorage();
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
      `UserOp ${i} carries the same call bytes`,
    );
  });

  const batched = capturingDeps();
  await createSponsoredSender(CONFIG, batched.deps).sendCalls(composed);
  assert.equal(batched.requests.length, 1);
  assert.equal(
    batched.requests[0].callData,
    encodeExecuteBatchCallData(walletWire),
    "the batched UserOp encodes the very calls the wallet sent",
  );
  clearPasskeyStorage();
});

test("senderRagequitDeps delivers the composed bytes unmodified", async () => {
  const tx = buildRagequitTx(DAO, {
    tokens: [ETH_TOKEN],
    sharesToBurn: 5n,
    lootToBurn: 0n,
    forbidden: [],
  });
  const walletWire = [];
  const passthrough = {
    async sendCalls(calls) {
      walletWire.push(...calls);
      return { txHash: `0x${"22".repeat(32)}`, receipts: [] };
    },
  };
  const deps = senderRagequitDeps(passthrough, async () => {});
  const sent = await deps.send(tx);
  assert.deepEqual(walletWire, [{ to: tx.to, data: tx.data, value: tx.value }]);
  assert.equal(sent.txHash, `0x${"22".repeat(32)}`);
  assert.equal(sent.status, "success");
});
