import assert from "node:assert/strict";
import test from "node:test";

import {
  bidFlowReducer,
  buildAllowanceCall,
  buildBidExecution,
  BID_STEP_LABELS,
  initialBidFlowState,
  remainingSteps,
  resumeFromState,
  runBidFlow,
} from "./bidHooks.ts";
import {
  bidPlanWithDefaultHint,
  PERMIT2_ADDRESS,
  ZERO_ADDRESS,
} from "./lib/evmCalls.ts";

// ---------------------------------------------------------------------------
// Fixtures. The plan/addresses mirror `lib/evmCalls.test.mjs` so the golden
// call vectors there apply to these executions too.
// ---------------------------------------------------------------------------

const OWNER = "0x1111111111111111111111111111111111111111";
const AUCTION = "0x5555555555555555555555555555555555555555";
const CURRENCY = "0x3333333333333333333333333333333333333333";
const RPC_URL = "http://rpc.test";
const CHAIN_ID = 8453;

const plan = bidPlanWithDefaultHint(
  {
    maxPriceQ96: 10n ** 21n,
    amount: 50_000_000_000n,
    owner: OWNER,
    hookData: "0x",
  },
  4_294_967_297n,
);

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
function recorder(initial = initialBidFlowState()) {
  let state = initial;
  const actions = [];
  return {
    actions,
    get state() {
      return state;
    },
    dispatch(action) {
      actions.push(action);
      state = bidFlowReducer(state, action);
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

function erc20Execution(publishMirror) {
  return buildBidExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    currency: CURRENCY,
    plan,
    needsUnderlyingAllowance: true,
    permit2Deadline: 4_102_444_800n,
    publishMirror,
  });
}

// ---------------------------------------------------------------------------
// buildAllowanceCall — the `evm_call` preflight
// ---------------------------------------------------------------------------

test("buildAllowanceCall encodes allowance(owner, PERMIT2)", () => {
  // Selector: `cast sig 'allowance(address,address)'` -> 0xdd62ed3e (the
  // standard ERC-20 allowance selector); argument words follow the ABI
  // (owner first, then the Permit2 spender). The full hex was read out of the
  // `encodeFunctionData` run cross-checked by `lib/evmCalls.test.mjs`'s
  // `cast`-pinned vectors.
  assert.equal(
    buildAllowanceCall(CURRENCY, OWNER).data,
    "0xdd62ed3e0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3",
  );
  assert.equal(buildAllowanceCall(CURRENCY, OWNER).to, CURRENCY);
});

// ---------------------------------------------------------------------------
// buildBidExecution — call labeling and ordering
// ---------------------------------------------------------------------------

test("buildBidExecution labels the ordered calls and appends the mirror step", () => {
  const execution = erc20Execution(async () => {});
  assert.deepEqual(execution.order, [
    "underlyingApprove",
    "permit2Approve",
    "submitBid",
    "mirrorPublish",
  ]);
  assert.deepEqual(
    execution.calls.map((entry) => entry.step),
    ["underlyingApprove", "permit2Approve", "submitBid"],
  );
  // Targets come straight from buildBidCalls (lib/evmCalls.test.mjs vectors).
  assert.equal(execution.calls[0].call.to, CURRENCY);
  assert.equal(execution.calls[1].call.to, PERMIT2_ADDRESS);
  assert.equal(execution.calls[2].call.to, AUCTION);
});

test("buildBidExecution on a native auction plans submitBid + mirror only", () => {
  const execution = buildBidExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    currency: ZERO_ADDRESS,
    plan,
    // Ignored for native auctions (lib/evmCalls.test.mjs native vector).
    needsUnderlyingAllowance: true,
    permit2Deadline: 0n,
    publishMirror: async () => {},
  });
  assert.deepEqual(execution.order, ["submitBid", "mirrorPublish"]);
  assert.equal(execution.calls.length, 1);
  // The vendored CCA enforces msg.value == amount for native bids — the same
  // 0xba43b7400 value lib/evmCalls.test.mjs pins for this plan.
  assert.equal(execution.calls[0].call.value, "0xba43b7400");
});

// ---------------------------------------------------------------------------
// Reducer — sequence -> states
// ---------------------------------------------------------------------------

test("reducer walks the happy sequence to done and binds the mirror hash", () => {
  const rec = recorder();
  const order = [
    "underlyingApprove",
    "permit2Approve",
    "submitBid",
    "mirrorPublish",
  ];
  rec.dispatch({ type: "reset", order });
  assert.equal(rec.state.phase, "idle");
  for (const step of order.slice(0, 2)) {
    rec.dispatch({ type: "step-start", step });
    rec.dispatch({ type: "step-done", step, receipt: receipt(`0x${step}`) });
  }
  rec.dispatch({ type: "step-start", step: "submitBid" });
  assert.equal(rec.state.phase, "running");
  assert.equal(rec.state.steps.submitBid, "active");
  rec.dispatch({
    type: "step-done",
    step: "submitBid",
    receipt: receipt("0xbid"),
  });
  // The bid is onchain but the mirror is not out yet: still running, hash set.
  assert.equal(rec.state.phase, "running");
  assert.equal(rec.state.bidTxHash, "0xbid");
  rec.dispatch({ type: "step-start", step: "mirrorPublish" });
  rec.dispatch({ type: "step-done", step: "mirrorPublish" });
  assert.equal(rec.state.phase, "done");
  assert.equal(rec.state.bidTxHash, "0xbid");
  assert.deepEqual(remainingSteps(rec.state), []);
});

test("reducer names the failed step and keeps completed steps visible", () => {
  const rec = recorder();
  const order = [
    "underlyingApprove",
    "permit2Approve",
    "submitBid",
    "mirrorPublish",
  ];
  rec.dispatch({ type: "reset", order });
  rec.dispatch({ type: "step-start", step: "underlyingApprove" });
  rec.dispatch({
    type: "step-done",
    step: "underlyingApprove",
    receipt: receipt("0xapprove"),
  });
  rec.dispatch({ type: "step-start", step: "permit2Approve" });
  rec.dispatch({
    type: "step-failed",
    step: "permit2Approve",
    message: "boom",
  });
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "permit2Approve");
  assert.equal(rec.state.errorMessage, "Permit2 approve failed — boom");
  // Completed-step state stays visible; retry sends exactly the remainder.
  assert.equal(rec.state.steps.underlyingApprove, "done");
  assert.equal(rec.state.steps.permit2Approve, "failed");
  assert.deepEqual(remainingSteps(rec.state), [
    "permit2Approve",
    "submitBid",
    "mirrorPublish",
  ]);
});

test("reducer distinguishes mirror-failure-after-success from a failed bid", () => {
  const rec = recorder();
  const order = [
    "underlyingApprove",
    "permit2Approve",
    "submitBid",
    "mirrorPublish",
  ];
  rec.dispatch({ type: "reset", order });
  for (const step of ["underlyingApprove", "permit2Approve"]) {
    rec.dispatch({ type: "step-start", step });
    rec.dispatch({ type: "step-done", step, receipt: receipt(`0x${step}`) });
  }
  rec.dispatch({ type: "step-start", step: "submitBid" });
  rec.dispatch({
    type: "step-done",
    step: "submitBid",
    receipt: receipt("0xbid"),
  });
  rec.dispatch({ type: "step-start", step: "mirrorPublish" });
  rec.dispatch({
    type: "step-failed",
    step: "mirrorPublish",
    message: "publish timeout",
  });
  assert.equal(rec.state.phase, "mirrorFailed");
  assert.equal(rec.state.failedStep, "mirrorPublish");
  assert.equal(
    rec.state.errorMessage,
    "Mirror publish failed — publish timeout",
  );
  assert.equal(rec.state.bidTxHash, "0xbid");
  assert.deepEqual(remainingSteps(rec.state), ["mirrorPublish"]);
});

// ---------------------------------------------------------------------------
// runBidFlow — the sequential orchestrator (production seam)
// ---------------------------------------------------------------------------

test("runBidFlow sends the three ERC-20 steps in order, then mirrors with the hash", async () => {
  const execution = erc20Execution(async () => {});
  const mirrored = [];
  const finalExecution = {
    ...execution,
    publishMirror: async (txHash) => {
      mirrored.push(txHash);
    },
  };
  const { deps, sends } = fakeDeps([
    receipt("0xunderlying"),
    receipt("0xpermit2"),
    receipt("0xbid"),
  ]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: finalExecution.order });
  await runBidFlow(finalExecution, deps, rec.dispatch);

  assert.equal(sends.length, 3);
  assert.deepEqual(
    sends.map((s) => s.to),
    [CURRENCY, PERMIT2_ADDRESS, AUCTION],
  );
  for (const send of sends) {
    assert.equal(send.rpcUrl, RPC_URL);
    assert.equal(send.chainId, CHAIN_ID);
    assert.equal(send.value, "0x0");
  }
  // The mirror is automatic and hash-bound — no user confirmation step.
  assert.deepEqual(mirrored, ["0xbid"]);
  assert.equal(rec.state.phase, "done");
  assert.equal(rec.state.bidTxHash, "0xbid");
});

test("runBidFlow passes the budget as msg.value on a native auction", async () => {
  const execution = buildBidExecution({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    auction: AUCTION,
    currency: ZERO_ADDRESS,
    plan,
    needsUnderlyingAllowance: false,
    permit2Deadline: 0n,
    publishMirror: async () => {},
  });
  const mirrored = [];
  const finalExecution = {
    ...execution,
    publishMirror: async (txHash) => {
      mirrored.push(txHash);
    },
  };
  const { deps, sends } = fakeDeps([receipt("0xbid")]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: finalExecution.order });
  await runBidFlow(finalExecution, deps, rec.dispatch);

  assert.equal(sends.length, 1);
  assert.equal(sends[0].value, "0xba43b7400");
  assert.deepEqual(mirrored, ["0xbid"]);
  assert.equal(rec.state.phase, "done");
});

test("runBidFlow stops at a failed step, names it, and never mirrors", async () => {
  const mirrored = [];
  const execution = erc20Execution(async (txHash) => {
    mirrored.push(txHash);
  });
  const { deps, sends } = fakeDeps([
    receipt("0xunderlying"),
    new Error("user rejected"),
  ]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: execution.order });
  await runBidFlow(execution, deps, rec.dispatch);

  // The third (money) call is never attempted and nothing is faked as sent.
  assert.equal(sends.length, 2);
  assert.deepEqual(mirrored, []);
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "permit2Approve");
  assert.equal(
    rec.state.errorMessage,
    "Permit2 approve failed — user rejected",
  );
  assert.equal(rec.state.steps.underlyingApprove, "done");
});

test("runBidFlow treats a mined revert as a failed step, not an exception", async () => {
  const mirrored = [];
  const execution = erc20Execution(async (txHash) => {
    mirrored.push(txHash);
  });
  const { deps } = fakeDeps([
    receipt("0xunderlying"),
    receipt("0xpermit2"),
    {
      txHash: "0xreverted",
      status: "reverted",
      blockNumber: 2,
      gasUsed: "50000",
      contractAddress: null,
    },
  ]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: execution.order });
  await runBidFlow(execution, deps, rec.dispatch);

  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "submitBid");
  assert.ok(rec.state.errorMessage.startsWith("Submit bid failed — "));
  assert.ok(rec.state.errorMessage.includes("0xreverted"));
  assert.deepEqual(mirrored, []);
  assert.equal(rec.state.bidTxHash, null);
});

test("mirror failure after a landed bid retries mirror-only and never re-sends money", async () => {
  const mirrored = [];
  let mirrorAttempts = 0;
  const execution = erc20Execution(async (txHash) => {
    mirrorAttempts += 1;
    if (mirrorAttempts === 1) throw new Error("publish timeout");
    mirrored.push(txHash);
  });
  const first = fakeDeps([
    receipt("0xunderlying"),
    receipt("0xpermit2"),
    receipt("0xbid"),
  ]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: execution.order });
  await runBidFlow(execution, first.deps, rec.dispatch);

  assert.equal(rec.state.phase, "mirrorFailed");
  assert.ok(rec.state.errorMessage.startsWith("Mirror publish failed — "));
  assert.equal(rec.state.bidTxHash, "0xbid");

  // Retry: the money action must NEVER be re-sent — only the mirror publish.
  const retryDeps = fakeDeps([]);
  const retryRec = recorder(rec.state);
  await runBidFlow(
    execution,
    retryDeps.deps,
    retryRec.dispatch,
    resumeFromState(rec.state),
  );
  assert.equal(
    retryDeps.sends.length,
    0,
    "mirror retry must not re-send any transaction",
  );
  // The hash binding survives the retry: same confirmed submitBid hash.
  assert.deepEqual(mirrored, ["0xbid"]);
  assert.equal(retryRec.state.phase, "done");
});

test("retry after a partial failure re-sends only the remaining steps", async () => {
  const mirrored = [];
  const execution = erc20Execution(async (txHash) => {
    mirrored.push(txHash);
  });
  // First attempt: underlying approve landed, Permit2 approve failed.
  const first = fakeDeps([receipt("0xunderlying"), new Error("dropped")]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: execution.order });
  await runBidFlow(execution, first.deps, rec.dispatch);
  assert.equal(rec.state.phase, "failed");

  const { deps, sends } = fakeDeps([receipt("0xpermit2"), receipt("0xbid")]);
  const retryRec = recorder(rec.state);
  await runBidFlow(
    execution,
    deps,
    retryRec.dispatch,
    resumeFromState(rec.state),
  );
  // Only the two unfinished transactions run (never the completed approve).
  assert.deepEqual(
    sends.map((s) => s.to),
    [PERMIT2_ADDRESS, AUCTION],
  );
  assert.deepEqual(mirrored, ["0xbid"]);
  assert.equal(retryRec.state.phase, "done");
  // Completed-step receipts survive the retry untouched.
  assert.equal(
    retryRec.state.receipts.underlyingApprove.txHash,
    "0xunderlying",
  );
});

test("runBidFlow refuses to mirror without a confirmed submitBid hash", async () => {
  const mirrored = [];
  const execution = erc20Execution(async (txHash) => {
    mirrored.push(txHash);
  });
  const { deps, sends } = fakeDeps([]);
  const rec = recorder();
  rec.dispatch({ type: "reset", order: execution.order });
  // A resume that claims the money steps are done but carries no hash binding.
  await runBidFlow(execution, deps, rec.dispatch, {
    completed: new Set(["underlyingApprove", "permit2Approve", "submitBid"]),
    bidTxHash: null,
  });
  assert.equal(sends.length, 0);
  assert.deepEqual(mirrored, [], "an unbindable mirror must not publish");
  assert.equal(rec.state.phase, "failed");
  assert.equal(rec.state.failedStep, "mirrorPublish");
  assert.ok(
    rec.state.errorMessage.includes("no confirmed submitBid transaction"),
  );
});

test("BID_STEP_LABELS names every step for failure messages", () => {
  const steps = [
    "underlyingApprove",
    "permit2Approve",
    "submitBid",
    "mirrorPublish",
  ];
  for (const step of steps) {
    assert.ok(
      BID_STEP_LABELS[step].length > 0,
      `step ${step} must have a human name`,
    );
  }
  // The four names the partial-failure copy promises (docs §Phase A1).
  assert.deepEqual(
    steps.map((step) => BID_STEP_LABELS[step]),
    ["Underlying approve", "Permit2 approve", "Submit bid", "Mirror publish"],
  );
});
