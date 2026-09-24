import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComputeDeploymentAddressView,
  buildInfraFeeView,
  decodeAddressWord,
  deployParamsForPlan,
  extractPoolParamsBlock,
  initMintFlow,
  MAX_INFRASTRUCTURE_FEE_BPS,
  MINT_STEPS,
  mintFlowReducer,
  MintPrepareError,
  prepareDeploy,
  resumeIndex,
  retryPlan,
  runDeploySteps,
  SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS,
  SELECTOR_INFRA_FEE_BPS,
  SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS,
  SIGNATURE_INFRA_FEE_BPS,
  treasuryGate,
} from "./mintFlow.ts";
import {
  buildTokenDeployCalls,
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  encodeDeployToken,
  ZERO_ADDRESS,
} from "./evmCalls.ts";

// ---------------------------------------------------------------------------
// Golden vectors (fresh `cast` output; do not hand-edit hex).
// ---------------------------------------------------------------------------

// `cast sig "infrastructureFeeBPS()"`
// `cast sig "computeDeploymentAddress(bytes32,(string,string,uint8,address,
//   address,uint256,bytes,address,bool,address,uint256),uint256,uint256)"`
const CAST_SIG_INFRA_FEE = "0xa82f4d02";
const CAST_SIG_COMPUTE_DEPLOYMENT_ADDRESS = "0x8d33f2bf";

// `cast calldata "computeDeploymentAddress(bytes32,(string,string,uint8,
//   address,address,uint256,bytes,address,bool,address,uint256),uint256,
//   uint256)" 0x…01 "(\"Nebula\",\"NEB\",18,0x1111…,0x0,100000000000000000,
//   <CAST_STANDARD_POOL_INIT_ARGS>,0x0,false,0x0,0)" 100000000000000000 250`
// — the DeployAppToken.s.sol defaults (same params CAST_DEPLOY_TOKEN in
// evmCalls.test.mjs encodes) with the live infra fee at the 250 bps cap.
const CAST_COMPUTE_DEPLOYMENT_ADDRESS =
  "0x" +
  "8d33f2bf0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000080" +
  "000000000000000000000000000000000000000000000000016345785d8a0000" +
  "00000000000000000000000000000000000000000000000000000000000000fa" +
  "0000000000000000000000000000000000000000000000000000000000000160" +
  "00000000000000000000000000000000000000000000000000000000000001a0" +
  "0000000000000000000000000000000000000000000000000000000000000012" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000016345785d8a0000" +
  "00000000000000000000000000000000000000000000000000000000000001e0" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000006" +
  "4e6562756c610000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "4e45420000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000380" +
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

const BIDDER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEPLOYED_TOKEN = "0x1234567890123456789012345678901234567890";

const planInputs = {
  name: "Nebula",
  symbol: "NEB",
  supply: "1000000",
  treasury: BIDDER,
};

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const addressWord = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

const receipt = (txHash, status = "success") => ({
  txHash,
  status,
  blockNumber: 1,
  gasUsed: "100000",
  contractAddress: null,
});

// ---------------------------------------------------------------------------
// View signatures + calldata (cast goldens)
// ---------------------------------------------------------------------------

test("view signatures and selectors match the pinned cast values", () => {
  assert.equal(SIGNATURE_INFRA_FEE_BPS, "infrastructureFeeBPS()");
  assert.equal(
    SIGNATURE_COMPUTE_DEPLOYMENT_ADDRESS,
    "computeDeploymentAddress(bytes32,(string,string,uint8,address,address," +
      "uint256,bytes,address,bool,address,uint256),uint256,uint256)",
  );
  assert.equal(SELECTOR_INFRA_FEE_BPS, CAST_SIG_INFRA_FEE);
  assert.equal(
    SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS,
    CAST_SIG_COMPUTE_DEPLOYMENT_ADDRESS,
  );
});

test("buildInfraFeeView targets the router with the bare selector", () => {
  const view = buildInfraFeeView();
  assert.equal(view.to, DEFAULT_TOKENMASTER_ROUTER);
  assert.equal(view.data, CAST_SIG_INFRA_FEE);
  assert.equal(
    buildInfraFeeView("0x5555555555555555555555555555555555555555").to,
    "0x5555555555555555555555555555555555555555",
  );
});

test("computeDeploymentAddress view matches cast (DeployAppToken defaults)", () => {
  const view = buildComputeDeploymentAddressView(
    deployParamsForPlan(planInputs, TOKEN),
    MAX_INFRASTRUCTURE_FEE_BPS,
  );
  assert.equal(view.to, DEFAULT_STANDARD_POOL_FACTORY);
  assert.equal(view.data, CAST_COMPUTE_DEPLOYMENT_ADDRESS);
});

test("the view splices the production deployToken encoder's pool block", () => {
  // Bind the splice to cast ground truth AND to the production encoder the
  // deploy transaction uses — the CREATE2 input must byte-match it.
  const poolFromDeploy = extractPoolParamsBlock(
    encodeDeployToken(deployParamsForPlan(planInputs, TOKEN)),
  );
  // The cast golden's pool block starts after its selector (4 bytes) and the
  // 4-word argument head (salt, offset, pairedValueIn, fee).
  const goldenPool = CAST_COMPUTE_DEPLOYMENT_ADDRESS.slice(2 + 2 * (4 + 128));
  assert.equal(`0x${goldenPool}`, poolFromDeploy);
  // tokenAddress lives outside poolParams, so a placeholder is equivalent.
  assert.equal(
    extractPoolParamsBlock(
      encodeDeployToken(deployParamsForPlan(planInputs, ZERO_ADDRESS)),
    ),
    poolFromDeploy,
  );
});

test("extractPoolParamsBlock rejects layout drift and truncation", () => {
  const deployData = encodeDeployToken(deployParamsForPlan(planInputs, TOKEN));
  // Zero a 32-byte word at the given byte offset (selector included).
  const zeroWordAt = (data, byteOffset) =>
    data.slice(0, 8 + byteOffset * 2) +
    "0".repeat(64) +
    data.slice(8 + byteOffset * 2 + 64);
  // Corrupt the DeploymentParameters offset word (args word 0).
  assert.throws(
    () => extractPoolParamsBlock(zeroWordAt(deployData, 4)),
    /layout drift/,
    "arg0 offset drift must throw",
  );
  // Corrupt the poolParams offset word (DeploymentParameters word 5).
  assert.throws(
    () => extractPoolParamsBlock(zeroWordAt(deployData, 4 + 128 + 5 * 32)),
    /layout drift/,
    "poolParams offset drift must throw",
  );
  assert.throws(
    () => extractPoolParamsBlock(deployData.slice(0, deployData.length - 4)),
    /truncated/,
  );
});

test("decodeAddressWord decodes a 32-byte word and rejects garbage", () => {
  assert.equal(decodeAddressWord(addressWord(TOKEN)), TOKEN);
  assert.throws(() => decodeAddressWord("0x1234"), /32-byte/);
  assert.throws(
    () => decodeAddressWord(`0x11${"0".repeat(22)}${TOKEN.slice(2)}`),
    /address word/,
  );
});

// ---------------------------------------------------------------------------
// Plan -> deploy params
// ---------------------------------------------------------------------------

test("deployParamsForPlan maps the mint plan to DeployAppToken defaults", () => {
  const params = deployParamsForPlan(planInputs, TOKEN);
  assert.deepEqual(params, {
    name: "Nebula",
    symbol: "NEB",
    treasury: BIDDER,
    tokenAddress: TOKEN,
    // 1000000 whole tokens at 18 decimals (DeployAppToken: supply * 1e18).
    initialSupplyAmount: 1_000_000n * 10n ** 18n,
  });
});

test("deployParamsForPlan rejects non-positive or fractional supplies", () => {
  for (const supply of ["", "abc", "0", "-1", "1.5", "1e6"]) {
    assert.throws(
      () => deployParamsForPlan({ ...planInputs, supply }, TOKEN),
      /supply/,
      `supply ${JSON.stringify(supply)} must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Treasury gate
// ---------------------------------------------------------------------------

test("treasuryGate adopts an unset record treasury as the wallet", () => {
  assert.deepEqual(treasuryGate(BIDDER, null), { ok: true, treasury: BIDDER });
  assert.deepEqual(treasuryGate(BIDDER, "  "), { ok: true, treasury: BIDDER });
});

test("treasuryGate matches the record treasury case-insensitively", () => {
  const mixed = `0x${BIDDER.slice(2).toUpperCase()}`;
  assert.deepEqual(treasuryGate(BIDDER, mixed), { ok: true, treasury: BIDDER });
});

test("treasuryGate blocks a mismatch and names both addresses", () => {
  const gate = treasuryGate(BIDDER, TOKEN);
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /1111111111111111111111111111111111111111/);
  assert.match(gate.detail, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(gate.detail, /treasury/);
});

// ---------------------------------------------------------------------------
// prepareDeploy (the two view calls, injected)
// ---------------------------------------------------------------------------

function callEffects(responses) {
  const seen = [];
  return {
    seen,
    call: async (target) => {
      seen.push(target);
      const next = responses[seen.length - 1];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("prepareDeploy runs the fee view then the address view (cast bytes)", async () => {
  const effects = callEffects([
    word(MAX_INFRASTRUCTURE_FEE_BPS),
    addressWord(DEPLOYED_TOKEN),
  ]);
  const prepared = await prepareDeploy(effects, planInputs);
  assert.equal(effects.seen.length, 2);
  assert.equal(effects.seen[0].to, DEFAULT_TOKENMASTER_ROUTER);
  assert.equal(effects.seen[0].data, CAST_SIG_INFRA_FEE);
  // The address view must be the exact cast golden (fee 250 in the args).
  assert.equal(effects.seen[1].data, CAST_COMPUTE_DEPLOYMENT_ADDRESS);
  assert.equal(prepared.tokenAddress, DEPLOYED_TOKEN);
  assert.equal(prepared.infrastructureFeeBps, 250n);
  assert.equal(prepared.params.tokenAddress, DEPLOYED_TOKEN);
  // Re-derived calls are exactly what the deploy runner sends.
  assert.deepEqual(
    prepared.calls,
    buildTokenDeployCalls({ ...prepared.params }),
  );
  assert.equal(prepared.calls.length, MINT_STEPS.length);
});

test("prepareDeploy blocks a live fee above the deploy cap before computing", async () => {
  const effects = callEffects([
    word(MAX_INFRASTRUCTURE_FEE_BPS + 1n),
    addressWord(DEPLOYED_TOKEN),
  ]);
  await assert.rejects(
    () => prepareDeploy(effects, planInputs),
    (error) => {
      assert.ok(error instanceof MintPrepareError);
      assert.equal(error.stage, "infrastructure-fee");
      assert.match(error.message, /above the 250 bps deploy cap/);
      return true;
    },
  );
  assert.equal(effects.seen.length, 1, "no address call after a blocked fee");
});

test("prepareDeploy names the exact view call that failed", async () => {
  const feeDown = callEffects([new Error("boom"), addressWord(DEPLOYED_TOKEN)]);
  await assert.rejects(
    () => prepareDeploy(feeDown, planInputs),
    (error) => {
      assert.equal(error.stage, "infrastructure-fee");
      assert.match(error.message, /infrastructureFeeBPS\(\)/);
      assert.match(error.message, /boom/);
      return true;
    },
  );
  const badFeeWord = callEffects(["0x1234", addressWord(DEPLOYED_TOKEN)]);
  await assert.rejects(
    () => prepareDeploy(badFeeWord, planInputs),
    (error) => error.stage === "infrastructure-fee",
  );
  const addressDown = callEffects([word(1n), new Error("nope")]);
  await assert.rejects(
    () => prepareDeploy(addressDown, planInputs),
    (error) => {
      assert.equal(error.stage, "token-address");
      assert.match(error.message, /computeDeploymentAddress/);
      return true;
    },
  );
  const zeroAddress = callEffects([word(1n), addressWord(ZERO_ADDRESS)]);
  await assert.rejects(
    () => prepareDeploy(zeroAddress, planInputs),
    (error) =>
      error.stage === "token-address" && /zero address/.test(error.message),
  );
  await assert.rejects(
    () => prepareDeploy(callEffects([]), { ...planInputs, supply: "x" }),
    (error) => error.stage === "plan",
  );
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduceAll(actions, from = initMintFlow()) {
  return actions.reduce(mintFlowReducer, from);
}

test("initMintFlow starts idle with three pending steps", () => {
  const state = initMintFlow();
  assert.equal(state.phase, "idle");
  assert.equal(state.steps.length, MINT_STEPS.length);
  assert.ok(
    state.steps.every((s) => s.status === "pending" && s.txHash === null),
  );
  assert.equal(state.tokenAddress, null);
  assert.equal(state.failure, null);
});

test("begin fresh resets a dirty run; begin resume keeps completed steps", () => {
  const dirty = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "prepared",
      tokenAddress: DEPLOYED_TOKEN,
      tokenAlreadyDeployed: false,
    },
    { type: "step_started", index: 0 },
    { type: "step_done", index: 0, txHash: "0xaa" },
    { type: "step_started", index: 1 },
    {
      type: "step_failed",
      index: 1,
      txHash: "0xbb",
      outcome: "reverted",
      reason: "r",
    },
  ]);
  assert.equal(dirty.phase, "paused");

  const fresh = mintFlowReducer(dirty, { type: "begin", mode: "fresh" });
  assert.equal(fresh.phase, "preparing");
  assert.ok(fresh.steps.every((s) => s.status === "pending"));
  assert.equal(fresh.tokenAddress, null);
  assert.equal(fresh.failure, null);

  const resumed = mintFlowReducer(dirty, { type: "begin", mode: "resume" });
  assert.equal(resumed.phase, "preparing");
  assert.equal(resumed.steps[0].status, "done");
  assert.equal(resumed.steps[0].txHash, "0xaa");
  assert.equal(resumed.steps[1].status, "pending");
  assert.equal(resumed.steps[1].txHash, null, "stale failed hash is cleared");
  assert.equal(resumed.tokenAddress, DEPLOYED_TOKEN);
  assert.equal(resumed.failure, null);
});

test("prepared with an existing token satisfies step 1 instead of resending", () => {
  const state = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "prepared",
      tokenAddress: DEPLOYED_TOKEN,
      tokenAlreadyDeployed: true,
    },
  ]);
  assert.equal(state.phase, "running");
  assert.equal(state.steps[0].status, "done");
  assert.equal(state.steps[0].txHash, null);
  assert.equal(state.tokenAlreadyDeployed, true);
});

test("step lifecycle: started -> done records the tx hash", () => {
  const state = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "prepared",
      tokenAddress: DEPLOYED_TOKEN,
      tokenAlreadyDeployed: false,
    },
    { type: "step_started", index: 0 },
  ]);
  assert.equal(state.steps[0].status, "running");
  const done = mintFlowReducer(state, {
    type: "step_done",
    index: 0,
    txHash: "0xabc",
  });
  assert.deepEqual(done.steps[0], { status: "done", txHash: "0xabc" });
  assert.equal(resumeIndex(done), 1);
});

test("a mined revert pauses at the failed step with the full failure record", () => {
  const state = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "prepared",
      tokenAddress: DEPLOYED_TOKEN,
      tokenAlreadyDeployed: false,
    },
    { type: "step_started", index: 0 },
    { type: "step_done", index: 0, txHash: "0xaa" },
    { type: "step_started", index: 1 },
    {
      type: "step_failed",
      index: 1,
      txHash: "0xbb",
      outcome: "reverted",
      reason: "transaction 0xbb reverted in block 7",
    },
  ]);
  assert.equal(state.phase, "paused");
  assert.deepEqual(state.steps[0], { status: "done", txHash: "0xaa" });
  assert.deepEqual(state.steps[1], { status: "failed", txHash: "0xbb" });
  assert.deepEqual(state.failure, {
    stage: "step",
    check: null,
    stepIndex: 1,
    txHash: "0xbb",
    outcome: "reverted",
    reason: "transaction 0xbb reverted in block 7",
  });
  assert.deepEqual(retryPlan(state), { kind: "steps", resumeAt: 1 });
});

test("an unknown deploy outcome is recorded as unknown, not dropped", () => {
  const state = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "prepared",
      tokenAddress: DEPLOYED_TOKEN,
      tokenAlreadyDeployed: false,
    },
    { type: "step_started", index: 0 },
    {
      type: "step_failed",
      index: 0,
      txHash: null,
      outcome: "unknown",
      reason: "ipc rejected",
    },
  ]);
  assert.equal(state.failure.outcome, "unknown");
  assert.equal(state.failure.txHash, null);
  assert.deepEqual(retryPlan(state), { kind: "steps", resumeAt: 0 });
});

test("a link failure retries only the record update, with the token kept", () => {
  const linked = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "prepared",
      tokenAddress: DEPLOYED_TOKEN,
      tokenAlreadyDeployed: true,
    },
    { type: "step_started", index: 1 },
    { type: "step_done", index: 1, txHash: "0x1" },
    { type: "step_started", index: 2 },
    { type: "step_done", index: 2, txHash: "0x2" },
    { type: "link_started" },
  ]);
  assert.equal(linked.phase, "linking");
  assert.deepEqual(retryPlan(linked), null);

  const failed = mintFlowReducer(linked, {
    type: "link_failed",
    reason: "timeout",
  });
  assert.equal(failed.phase, "paused");
  assert.deepEqual(retryPlan(failed), {
    kind: "record",
    tokenAddress: DEPLOYED_TOKEN,
  });
  assert.equal(resumeIndex(failed), MINT_STEPS.length, "all steps stay done");

  const done = mintFlowReducer(failed, { type: "linked" });
  assert.equal(done.phase, "success");
  assert.equal(done.failure, null);
  assert.deepEqual(retryPlan(done), null);
});

test("a blocked preflight names its check and offers no step retry", () => {
  const state = reduceAll([
    { type: "begin", mode: "fresh" },
    {
      type: "blocked",
      stage: "infrastructure-fee",
      detail: "router fee read failed",
    },
  ]);
  assert.equal(state.phase, "blocked");
  assert.equal(state.failure.stage, "prepare");
  assert.equal(state.failure.check, "infrastructure-fee");
  assert.equal(state.failure.reason, "router fee read failed");
  assert.deepEqual(retryPlan(state), null);
});

// ---------------------------------------------------------------------------
// runDeploySteps (sequential orchestration, injected)
// ---------------------------------------------------------------------------

function recordingSend(outcomes) {
  const sent = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    sent,
    maxInFlight: () => maxInFlight,
    send: async (call) => {
      sent.push(call);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      const outcome = outcomes[sent.length - 1] ?? receipt(`0x${sent.length}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function replay() {
  const log = [];
  let state = initMintFlow();
  const dispatch = (action) => {
    log.push(action);
    state = mintFlowReducer(state, action);
  };
  return {
    log,
    dispatch,
    state: () => state,
  };
}

test("runDeploySteps sends the three calls one receipt at a time", async () => {
  const prepared = await prepareDeploy(
    callEffects([
      word(MAX_INFRASTRUCTURE_FEE_BPS),
      addressWord(DEPLOYED_TOKEN),
    ]),
    planInputs,
  );
  const sender = recordingSend([
    receipt("0x1"),
    receipt("0x2"),
    receipt("0x3"),
  ]);
  const run = replay();
  const outcome = await runDeploySteps({
    calls: prepared.calls,
    startAt: 0,
    effects: sender,
    dispatch: run.dispatch,
  });
  assert.deepEqual(outcome, { completed: true });
  assert.equal(sender.sent.length, 3);
  assert.equal(
    sender.maxInFlight(),
    1,
    "each receipt is awaited before the next send",
  );
  assert.deepEqual(
    sender.sent.map((c) => c.to),
    [DEFAULT_TOKENMASTER_ROUTER, DEPLOYED_TOKEN, prepared.calls[2].to],
    "sends follow buildTokenDeployCalls' order",
  );
  assert.deepEqual(
    sender.sent.map((c) => c.data),
    prepared.calls.map((c) => c.data),
  );
  assert.deepEqual(
    run.log.map((a) => a.type),
    [
      "step_started",
      "step_done",
      "step_started",
      "step_done",
      "step_started",
      "step_done",
    ],
  );
  assert.deepEqual(run.state().steps, [
    { status: "done", txHash: "0x1" },
    { status: "done", txHash: "0x2" },
    { status: "done", txHash: "0x3" },
  ]);
});

test("runDeploySteps halts on the first revert and names the step", async () => {
  const calls = buildTokenDeployCalls(deployParamsForPlan(planInputs, TOKEN));
  const sender = recordingSend([receipt("0x1"), receipt("0x2", "reverted")]);
  const run = replay();
  const outcome = await runDeploySteps({
    calls,
    startAt: 0,
    effects: sender,
    dispatch: run.dispatch,
  });
  assert.deepEqual(outcome, { completed: false });
  assert.equal(sender.sent.length, 2, "step 3 is never attempted");
  assert.deepEqual(
    run.log.map((a) => a.type),
    ["step_started", "step_done", "step_started", "step_failed"],
  );
  assert.deepEqual(run.log[3], {
    type: "step_failed",
    index: 1,
    txHash: "0x2",
    outcome: "reverted",
    reason: "transaction 0x2 reverted in block 1",
  });
  assert.deepEqual(retryPlan(run.state()), { kind: "steps", resumeAt: 1 });
});

test("runDeploySteps reports an unknown outcome and stops", async () => {
  const calls = buildTokenDeployCalls(deployParamsForPlan(planInputs, TOKEN));
  const sender = recordingSend([new Error("ipc unavailable")]);
  const run = replay();
  const outcome = await runDeploySteps({
    calls,
    startAt: 0,
    effects: sender,
    dispatch: run.dispatch,
  });
  assert.deepEqual(outcome, { completed: false });
  assert.equal(sender.sent.length, 1);
  assert.deepEqual(run.log[1], {
    type: "step_failed",
    index: 0,
    txHash: null,
    outcome: "unknown",
    reason: "ipc unavailable",
  });
});

test("runDeploySteps resumes at the failed step on retry", async () => {
  const calls = buildTokenDeployCalls(deployParamsForPlan(planInputs, TOKEN));
  const sender = recordingSend([receipt("0x3")]);
  const run = replay();
  const outcome = await runDeploySteps({
    calls,
    startAt: 2,
    effects: sender,
    dispatch: run.dispatch,
  });
  assert.deepEqual(outcome, { completed: true });
  assert.equal(sender.sent.length, 1, "only the remaining step is re-sent");
  assert.deepEqual(run.log[0], { type: "step_started", index: 2 });
});

test("runDeploySteps rejects a call list of the wrong length", async () => {
  const sender = recordingSend([]);
  await assert.rejects(
    () =>
      runDeploySteps({
        calls: [],
        startAt: 0,
        effects: sender,
        dispatch: () => {},
      }),
    /expected 3 deploy calls/,
  );
});

// ---------------------------------------------------------------------------
// End-to-end seam: prepare -> sequential sends -> link, through the reducer
// ---------------------------------------------------------------------------

test("a full run drives the reducer to success and links the token", async () => {
  const run = replay();
  const effects = callEffects([
    word(MAX_INFRASTRUCTURE_FEE_BPS),
    addressWord(DEPLOYED_TOKEN),
  ]);
  run.dispatch({ type: "begin", mode: "fresh" });
  const prepared = await prepareDeploy(effects, planInputs);
  run.dispatch({
    type: "prepared",
    tokenAddress: prepared.tokenAddress,
    tokenAlreadyDeployed: false,
  });
  const sender = recordingSend([
    receipt("0x1"),
    receipt("0x2"),
    receipt("0x3"),
  ]);
  const outcome = await runDeploySteps({
    calls: prepared.calls,
    startAt: 0,
    effects: sender,
    dispatch: run.dispatch,
  });
  assert.equal(outcome.completed, true);
  run.dispatch({ type: "link_started" });
  run.dispatch({ type: "linked" });
  const state = run.state();
  assert.equal(state.phase, "success");
  assert.equal(state.tokenAddress, DEPLOYED_TOKEN);
  assert.ok(state.steps.every((s) => s.status === "done"));
});

test("a partial failure keeps completed state and re-derives on retry", async () => {
  // First attempt: step 1 succeeds, step 2 reverts.
  let state = initMintFlow();
  const apply = (action) => {
    state = mintFlowReducer(state, action);
  };
  apply({ type: "begin", mode: "fresh" });
  apply({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  const calls = buildTokenDeployCalls(deployParamsForPlan(planInputs, TOKEN));
  const attempt1 = recordingSend([receipt("0x1"), receipt("0x2", "reverted")]);
  await runDeploySteps({
    calls,
    startAt: 0,
    effects: attempt1,
    dispatch: apply,
  });
  assert.deepEqual(retryPlan(state), { kind: "steps", resumeAt: 1 });

  // Retry re-derives (prepareDeploy) and resumes at step 2 only.
  apply({ type: "begin", mode: "resume" });
  const effects = callEffects([
    word(MAX_INFRASTRUCTURE_FEE_BPS),
    addressWord(DEPLOYED_TOKEN),
  ]);
  const prepared = await prepareDeploy(effects, planInputs);
  apply({
    type: "prepared",
    tokenAddress: prepared.tokenAddress,
    tokenAlreadyDeployed: true,
  });
  assert.equal(state.steps[0].status, "done", "step 1 is not re-sent");
  const attempt2 = recordingSend([receipt("0x2b"), receipt("0x3")]);
  const outcome = await runDeploySteps({
    calls: prepared.calls,
    startAt: 1,
    effects: attempt2,
    dispatch: apply,
  });
  assert.deepEqual(outcome, { completed: true });
  assert.equal(attempt2.sent.length, 2);
  assert.ok(state.steps.every((s) => s.status === "done"));
  assert.equal(
    state.steps[0].txHash,
    "0x1",
    "the original deploy hash survives the retry",
  );
});

test("an unknown deploy outcome is recovered by the code check on retry", async () => {
  let state = initMintFlow();
  const apply = (action) => {
    state = mintFlowReducer(state, action);
  };
  apply({ type: "begin", mode: "fresh" });
  apply({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  apply({ type: "step_started", index: 0 });
  apply({
    type: "step_failed",
    index: 0,
    txHash: null,
    outcome: "unknown",
    reason: "ipc dropped",
  });
  // Retry: the earlier transaction actually landed — the hook's code check
  // reports the token as deployed and step 1 is satisfied instead of resent.
  apply({ type: "begin", mode: "resume" });
  apply({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: true,
  });
  assert.equal(state.steps[0].status, "done");
  const sender = recordingSend([receipt("0x2"), receipt("0x3")]);
  const outcome = await runDeploySteps({
    calls: buildTokenDeployCalls(deployParamsForPlan(planInputs, TOKEN)),
    startAt: 1,
    effects: sender,
    dispatch: apply,
  });
  assert.deepEqual(outcome, { completed: true });
  assert.equal(sender.sent.length, 2, "the deploy call is not re-sent");
});
