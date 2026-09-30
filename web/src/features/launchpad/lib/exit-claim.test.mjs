// Exit/claim flow semantics + composer/sender calldata parity.
//
// The reducer/orchestrator scenarios port `desktop/src/features/launchpad/
// exitHooks.test.mjs`'s runExitFlow section (lines 690-885, cited per test);
// the parity block mirrors `identity/lib/sponsoredSender.test.mjs`'s bid
// parity test (its "call parity" section) for the exit/claim/mint composers:
// the same composed calls must reach BOTH adapters byte-identically — the
// sender swap is allowed to change only the wire wrapper (one batched UserOp
// vs sequential wallet txs), never a calldata byte.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSponsoredSender,
  encodeExecuteBatchCallData,
  encodeExecuteSingleCallData,
  PASSKEY_CREDENTIAL_STORAGE_KEY,
} from "../../identity/lib/sponsoredSender.ts";
import { createInjectedWalletSender } from "./wallet-sender.ts";
import { resolveSender } from "./sender-choice.ts";
import {
  buildClaimExecution,
  buildExitExecution,
  EXIT_STEP_LABELS,
} from "./my-bids.ts";
import {
  completedExitSteps,
  exitFlowReducer,
  initialExitFlowState,
  remainingExitSteps,
  resumeExitFromState,
  runExitFlow,
} from "./exit-flow.ts";
import { buildTokenDeployCalls } from "./mint-tx.ts";

// ------------------------------------------------------------- fixtures ----

const AUCTION = "0x5555555555555555555555555555555555555555";
const OWNER = "0x2222222222222222222222222222222222222222";
const KERNEL_ADDR = "0x3333333333333333333333333333333333333333";
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

/** Scripted send fake: queue of receipts, thrown errors, or fns. */
function fakeDeps(script) {
  const sends = [];
  const queue = [...script];
  return {
    sends,
    deps: {
      async send(call) {
        sends.push(call);
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted receipt left");
        if (typeof next === "function") return next(call);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function twoStepExecution() {
  return buildExitExecution({
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

function dispatchReset(rec, order) {
  rec.dispatch({ type: "reset", order });
}

// ---------------------------------------------------------------------------
// runExitFlow — sequential send, named failures, retry-remaining
// (port of exitHooks.test.mjs:766-885)
// ---------------------------------------------------------------------------

test("runExitFlow runs one step to done", async () => {
  const rec = recorder();
  const { deps, sends } = fakeDeps([receipt("0xaaa")]);
  dispatchReset(rec, ["exit"]);
  await runExitFlow(
    buildExitExecution({
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
  const { deps } = fakeDeps([{ txHash: "0xdead", status: "reverted" }]);
  dispatchReset(rec, ["claim"]);
  await runExitFlow(
    buildClaimExecution({ auction: AUCTION, owner: OWNER, bidIds: [7n] }),
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

test("EXIT_STEP_LABELS drives the failure message prefix", async () => {
  assert.deepEqual(Object.values(EXIT_STEP_LABELS).sort(), [
    "Claim tokens",
    "Exit bid",
    "Write checkpoint",
  ]);
});

// ---------------------------------------------------------------------------
// Composer/sender calldata parity — exit/claim/mint bytes reach both adapters
// byte-identically (mirror of sponsoredSender.test.mjs's "call parity" block).
// ---------------------------------------------------------------------------

test("exit/claim/mint composition reaches both senders byte-identically", async () => {
  // Three representative compositions: a single-call exit, the batch claim,
  // and the 3-call mint sequence. All are sender-agnostic `build()` outputs.
  const exit = buildExitExecution({
    auction: AUCTION,
    bidId: 42n,
    plan: {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: 123n,
      outbidBlock: 456n,
    },
  });
  const claim = buildClaimExecution({
    auction: AUCTION,
    owner: OWNER,
    bidIds: [1n, 2n, 3n],
  });
  const mint = buildTokenDeployCalls({
    name: "Nebula",
    symbol: "NEB",
    treasury: OWNER,
    tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const composed = [
    await exit.calls[0].build(),
    await claim.calls[0].build(),
    ...mint.map((call) => ({
      to: call.to,
      value: call.value,
      data: call.data,
    })),
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

  // Sponsored path: capture at the kernel033 UserOp wire. Per-call mode must
  // carry each wallet-delivered call byte-identically in its own UserOp.
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

  // Batch mode: one UserOp whose batch executionData is exactly those calls.
  const batched = capturingDeps();
  await createSponsoredSender(CONFIG, batched.deps).sendCalls(composed);
  assert.equal(batched.requests.length, 1);
  assert.equal(
    batched.requests[0].callData,
    encodeExecuteBatchCallData(walletWire),
    "the batched UserOp encodes the very calls the wallet sent",
  );
});

// ---------------------------------------------------------------------------
// isAvailable truth tables — the picker's resolveSender choice seam
// ---------------------------------------------------------------------------

test("resolveSender truth table: kind × wallet × sponsored availability", async () => {
  // Two supported wallets (present/absent) × two sponsored states (ready /
  // missing credential) × two choices = 8 rows. Every row must resolve to the
  // chosen adapter whose isAvailable() reflects that adapter's own truth.
  const walletProvider = {
    request: async () => {
      throw new Error("not used");
    },
  };
  const rows = [];
  for (const kind of ["wallet", "passkey"]) {
    for (const withWallet of [true, false]) {
      for (const sponsoredReady of [true, false]) {
        if (sponsoredReady) seedPasskeyStorage();
        else clearPasskeyStorage();
        const sponsored = createSponsoredSender(CONFIG, capturingDeps().deps);
        const sender = resolveSender({
          kind,
          wallet: withWallet ? walletProvider : undefined,
          sponsoredSender: sponsored,
        });
        rows.push({
          kind,
          withWallet,
          sponsoredReady,
          available: sender.isAvailable(),
          isSponsored: sender === sponsored,
        });
      }
    }
  }
  assert.deepEqual(rows, [
    // wallet choice: availability is exactly "an injected wallet exists".
    {
      kind: "wallet",
      withWallet: true,
      sponsoredReady: true,
      available: true,
      isSponsored: false,
    },
    {
      kind: "wallet",
      withWallet: true,
      sponsoredReady: false,
      available: true,
      isSponsored: false,
    },
    {
      kind: "wallet",
      withWallet: false,
      sponsoredReady: true,
      available: false,
      isSponsored: false,
    },
    {
      kind: "wallet",
      withWallet: false,
      sponsoredReady: false,
      available: false,
      isSponsored: false,
    },
    // passkey choice: availability is exactly the sponsored stack's.
    {
      kind: "passkey",
      withWallet: true,
      sponsoredReady: true,
      available: true,
      isSponsored: true,
    },
    {
      kind: "passkey",
      withWallet: true,
      sponsoredReady: false,
      available: false,
      isSponsored: true,
    },
    {
      kind: "passkey",
      withWallet: false,
      sponsoredReady: true,
      available: true,
      isSponsored: true,
    },
    {
      kind: "passkey",
      withWallet: false,
      sponsoredReady: false,
      available: false,
      isSponsored: true,
    },
  ]);
});
