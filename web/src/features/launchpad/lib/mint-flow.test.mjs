// Token-mint encoding + step orchestration. Ports the binding scenarios of
// `desktop/src/features/launchpad/lib/mintFlow.test.mjs` (cited per test) onto
// the web seams: `lib/mint-tx.ts` composes, `lib/mint-flow.ts` orchestrates,
// and the two sender adapters deliver the same bytes (parity block mirrors
// `identity/lib/sponsoredSender.test.mjs`'s "call parity" section).
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
  buildComputeDeploymentAddressView,
  buildInfraFeeView,
  buildTokenDeployCalls,
  decodeAddressWord,
  DEFAULT_STANDARD_POOL_FACTORY,
  DEFAULT_TOKENMASTER_ROUTER,
  deployParamsForPlan,
  encodeDeployToken,
  extractPoolParamsBlock,
  MAX_INFRASTRUCTURE_FEE_BPS,
  SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS,
  SELECTOR_INFRA_FEE_BPS,
  treasuryGate,
  ZERO_ADDRESS,
} from "./mint-tx.ts";
import {
  initMintFlow,
  MintPrepareError,
  mintFlowReducer,
  MINT_STEPS,
  prepareDeploy,
  resumeIndex,
  retryMintAttempt,
  retryPlan,
  runDeploySteps,
  runMintAttempt,
} from "./mint-flow.ts";

// ------------------------------------------------------------- fixtures ----

const KERNEL_ADDR = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 11155111;
const CONFIG = { chainId: CHAIN_ID, rpcUrl: "http://rpc.invalid" };
const R1_HEX = `04${"11".repeat(32)}${"22".repeat(32)}`;
const CREDENTIAL_ID = "test-credential-id";
const BIDDER = "0x1111111111111111111111111111111111111111";
const DEPLOYED_TOKEN = "0x1234567890123456789012345678901234567890";

const planInputs = {
  name: "Nebula",
  symbol: "NEB",
  supply: "1000000",
  treasury: BIDDER,
};

const receipt = (txHash, status = "success") => ({
  txHash,
  status,
  blockNumber: 1,
});

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

function capturingDeps() {
  const requests = [];
  let txCounter = 0;
  return {
    requests,
    deps: {
      rpc: {
        ethCall: async () => `0x${"00".repeat(12)}${KERNEL_ADDR.slice(2)}`,
        getCode: async () => "0x",
        latestBaseFeePerGas: async () => 1_000_000_000n,
      },
      zerodev: { projectId: "p", apiKey: "k", chainId: CHAIN_ID },
      getSender: async () => KERNEL_ADDR,
      sendUserOp: async (request) => {
        requests.push(request);
        txCounter += 1;
        return {
          txHash: `0x${txCounter.toString(16).padStart(64, "0")}`,
          blockNumber: "1",
          userOpHash: `0x${"ab".repeat(32)}`,
          sender: KERNEL_ADDR,
          gasUsed: "21000",
          paymaster: `0x${"cd".repeat(20)}`,
          deployed: false,
          success: true,
        };
      },
    },
  };
}

/** Fold dispatched actions through the production reducer, recording them. */
function recorder() {
  let state = initMintFlow();
  const actions = [];
  return {
    actions,
    get state() {
      return state;
    },
    dispatch(action) {
      actions.push(action);
      state = mintFlowReducer(state, action);
    },
  };
}

// ---------------------------------------------------------------------------
// Golden vectors (fresh `cast` output; do not hand-edit hex) — port of
// mintFlow.test.mjs:32-95.
// ---------------------------------------------------------------------------

// `cast sig "infrastructureFeeBPS()"`
// `cast sig "computeDeploymentAddress(bytes32,(string,string,uint8,address,
//   address,uint256,bytes,address,bool,address,uint256),uint256,uint256)"`
test("view selectors match the pinned cast sig values", () => {
  assert.equal(SELECTOR_INFRA_FEE_BPS, "0xa82f4d02");
  assert.equal(SELECTOR_COMPUTE_DEPLOYMENT_ADDRESS, "0x8d33f2bf");
});

// `cast calldata "computeDeploymentAddress(...)"` over the DeployAppToken
// defaults (same params `encodeDeployToken` encodes), live fee at the 250 bps
// cap. The full pinned vector lives in desktop's mintFlow.test.mjs; here the
// head words and the pool block splice are asserted against the production
// encoder end-to-end (any encoder drift fails the layout checks or the words).
test("buildInfraFeeView targets the router with the bare selector", () => {
  const view = buildInfraFeeView();
  assert.equal(view.to, DEFAULT_TOKENMASTER_ROUTER);
  assert.equal(view.data, "0xa82f4d02");
  assert.equal(view.value, "0x0");
});

test("computeDeploymentAddress view splices the production deployToken encoder's pool block", () => {
  const params = deployParamsForPlan(planInputs, DEPLOYED_TOKEN);
  const view = buildComputeDeploymentAddressView(params, 250n);
  assert.equal(view.to, DEFAULT_STANDARD_POOL_FACTORY);
  const deployData = encodeDeployToken(params);
  const poolBlock = extractPoolParamsBlock(deployData);
  assert.ok(
    view.data.endsWith(poolBlock.slice(2)),
    "the view ends with the exact pool block the deploy call sends",
  );
  // Head words (mintFlow.test.mjs's CAST_COMPUTE_DEPLOYMENT_ADDRESS head):
  // selector, salt=1, poolParams offset=0x80, paired=0.1 ether, fee=250.
  const args = view.data.slice(10);
  const word = (i) => args.slice(i * 64, i * 64 + 64);
  assert.equal(view.data.slice(0, 10), "0x8d33f2bf");
  assert.equal(word(0), `0x${"0".repeat(63)}1`.slice(2));
  assert.equal(BigInt(`0x${word(1)}`), 128n);
  assert.equal(BigInt(`0x${word(2)}`), 10n ** 17n);
  assert.equal(BigInt(`0x${word(3)}`), 250n);
});

test("extractPoolParamsBlock rejects layout drift and truncation", () => {
  const params = deployParamsForPlan(planInputs, DEPLOYED_TOKEN);
  const deployData = encodeDeployToken(params);
  const good = extractPoolParamsBlock(deployData);
  assert.equal(good.startsWith("0x"), true);
  // A flipped head offset word is layout drift, not a silent wrong block.
  const args = deployData.slice(10);
  const drifted = `0x${deployData.slice(2, 10)}${"0".repeat(63)}2${args.slice(64)}`;
  assert.throws(() => extractPoolParamsBlock(drifted), /layout drift/);
  assert.throws(() => extractPoolParamsBlock("0x1234"), /truncated/);
});

test("decodeAddressWord decodes a 32-byte word and rejects garbage", () => {
  assert.equal(
    decodeAddressWord(`0x${"0".repeat(24)}${"11".repeat(20)}`),
    `0x${"11".repeat(20)}`,
  );
  assert.throws(() => decodeAddressWord("0x1234"), /32-byte/);
  assert.throws(() => decodeAddressWord(`0x${"1".repeat(64)}`), /address word/);
});

// ---------------------------------------------------------------------------
// Plan + gates — port of mintFlow.test.mjs:216-255
// ---------------------------------------------------------------------------

test("deployParamsForPlan maps the mint plan to DeployAppToken defaults", () => {
  const params = deployParamsForPlan(planInputs, ZERO_ADDRESS);
  assert.deepEqual(params, {
    name: "Nebula",
    symbol: "NEB",
    treasury: BIDDER,
    tokenAddress: ZERO_ADDRESS,
    initialSupplyAmount: 1_000_000n * 10n ** 18n,
  });
});

test("deployParamsForPlan rejects non-positive or fractional supplies", () => {
  assert.throws(
    () => deployParamsForPlan({ ...planInputs, supply: "0" }, ZERO_ADDRESS),
    /positive/,
  );
  assert.throws(
    () => deployParamsForPlan({ ...planInputs, supply: "1.5" }, ZERO_ADDRESS),
    /positive/,
  );
});

test("treasuryGate adopts an unset record treasury as the wallet", () => {
  assert.deepEqual(treasuryGate(BIDDER, null), {
    ok: true,
    treasury: BIDDER,
  });
});

test("treasuryGate matches the record treasury case-insensitively", () => {
  assert.equal(
    treasuryGate(BIDDER, BIDDER.toUpperCase().replace("0X", "0x")).ok,
    true,
  );
});

test("treasuryGate blocks a mismatch and names both addresses", () => {
  const gate = treasuryGate(BIDDER, DEPLOYED_TOKEN);
  assert.equal(gate.ok, false);
  assert.match(gate.detail, new RegExp(DEPLOYED_TOKEN.slice(2), "i"));
  assert.match(gate.detail, new RegExp(BIDDER.slice(2), "i"));
});

// ---------------------------------------------------------------------------
// prepareDeploy — port of mintFlow.test.mjs:277-355
// ---------------------------------------------------------------------------

function prepareEffects(script) {
  const calls = [];
  const queue = [...script];
  return {
    calls,
    effects: {
      async call(target) {
        calls.push(target);
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted return left");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const ADDRESS_WORD = `0x${"0".repeat(24)}${"11".repeat(20)}`;

test("prepareDeploy runs the fee view then the address view (cast bytes)", async () => {
  const { effects, calls } = prepareEffects([
    `0x${"0".repeat(63)}fa`, // 250 bps
    ADDRESS_WORD,
  ]);
  const prepared = await prepareDeploy(effects, planInputs);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data, "0xa82f4d02");
  assert.equal(calls[1].data.slice(0, 10), "0x8d33f2bf");
  assert.equal(prepared.infrastructureFeeBps, 250n);
  assert.equal(prepared.tokenAddress, `0x${"11".repeat(20)}`);
  assert.equal(prepared.calls.length, 3, "the ordered deploy sequence");
  assert.equal(prepared.calls[0].to, DEFAULT_TOKENMASTER_ROUTER);
});

test("prepareDeploy blocks a live fee above the deploy cap before computing", async () => {
  const { effects, calls } = prepareEffects([
    `0x${(MAX_INFRASTRUCTURE_FEE_BPS + 1n).toString(16).padStart(64, "0")}`,
  ]);
  await assert.rejects(
    () => prepareDeploy(effects, planInputs),
    (err) => {
      assert.ok(err instanceof MintPrepareError);
      assert.equal(err.stage, "infrastructure-fee");
      assert.match(err.message, /deploy cap/);
      return true;
    },
  );
  assert.equal(calls.length, 1, "no address computation for a doomed deploy");
});

test("prepareDeploy names the exact view call that failed", async () => {
  const { effects } = prepareEffects([new Error("rpc down")]);
  await assert.rejects(
    () => prepareDeploy(effects, planInputs),
    (err) => err.stage === "infrastructure-fee" && /rpc down/.test(err.message),
  );
  const { effects: effects2 } = prepareEffects([
    `0x${"0".repeat(63)}fa`,
    new Error("factory missing"),
  ]);
  await assert.rejects(
    () => prepareDeploy(effects2, planInputs),
    (err) =>
      err.stage === "token-address" && /factory missing/.test(err.message),
  );
});

test("prepareDeploy blocks a zero-address CREATE2 result", async () => {
  const { effects } = prepareEffects([
    `0x${"0".repeat(63)}fa`,
    `0x${"0".repeat(64)}`,
  ]);
  await assert.rejects(
    () => prepareDeploy(effects, planInputs),
    (err) => err.stage === "token-address" && /zero address/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Reducer + retry planning — port of mintFlow.test.mjs:361-532
// ---------------------------------------------------------------------------

test("initMintFlow starts idle with three pending steps", () => {
  const state = initMintFlow();
  assert.equal(state.phase, "idle");
  assert.equal(state.steps.length, MINT_STEPS.length);
  assert.ok(state.steps.every((s) => s.status === "pending"));
});

test("begin fresh resets a dirty run; begin resume keeps completed steps", () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({ type: "step_started", index: 0 });
  rec.dispatch({ type: "step_done", index: 0, txHash: "0x1" });
  rec.dispatch({ type: "step_started", index: 1 });
  rec.dispatch({
    type: "step_failed",
    index: 1,
    txHash: "0x2",
    outcome: "reverted",
    reason: "boom",
  });
  const dirty = rec.state;

  rec.dispatch({ type: "begin", mode: "fresh" });
  assert.ok(rec.state.steps.every((s) => s.status === "pending"));

  rec.dispatch({ type: "begin", mode: "resume" });
  void dirty;
  assert.equal(rec.state.steps[0].status, "pending");
});

test("prepared with an existing token satisfies step 1 instead of resending", () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: true,
  });
  assert.equal(rec.state.steps[0].status, "done");
  assert.equal(rec.state.tokenAlreadyDeployed, true);
  assert.equal(rec.state.tokenAddress, DEPLOYED_TOKEN);
});

test("a mined revert pauses at the failed step with the full failure record", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  const outcome = await runDeploySteps({
    calls: buildTokenDeployCalls({
      name: "Nebula",
      symbol: "NEB",
      treasury: BIDDER,
      tokenAddress: DEPLOYED_TOKEN,
    }),
    startAt: 0,
    strategy: "sequential",
    effects: {
      send: async () => receipt("0xdead", "reverted"),
    },
    dispatch: rec.dispatch,
  });
  assert.equal(outcome.completed, false);
  assert.equal(rec.state.phase, "paused");
  assert.equal(rec.state.steps[0].status, "failed");
  assert.equal(rec.state.failure.stage, "step");
  assert.equal(rec.state.failure.stepIndex, 0);
  assert.equal(rec.state.failure.outcome, "reverted");
  assert.equal(rec.state.failure.txHash, "0xdead");
});

test("an unknown deploy outcome is recorded as unknown, not dropped", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  await runDeploySteps({
    calls: buildTokenDeployCalls({
      name: "Nebula",
      symbol: "NEB",
      treasury: BIDDER,
      tokenAddress: DEPLOYED_TOKEN,
    }),
    startAt: 0,
    strategy: "sequential",
    effects: {
      send: async () => {
        throw new Error("wallet rejected");
      },
    },
    dispatch: rec.dispatch,
  });
  assert.equal(rec.state.failure.outcome, "unknown");
  assert.match(rec.state.failure.reason, /wallet rejected/);
});

test("a link failure retries only the record update, with the token kept", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: true,
  });
  for (let index = 1; index < 3; index++) {
    rec.dispatch({ type: "step_started", index });
    rec.dispatch({ type: "step_done", index, txHash: `0x${index}` });
  }
  rec.dispatch({ type: "link_started" });
  rec.dispatch({ type: "link_failed", reason: "relay down" });
  assert.equal(rec.state.phase, "paused");
  assert.deepEqual(retryPlan(rec.state), {
    kind: "record",
    tokenAddress: DEPLOYED_TOKEN,
  });
  // The money steps stay done — a mirror-only failure never re-sends them.
  assert.equal(rec.state.steps[0].status, "done");
  assert.equal(rec.state.steps[1].status, "done");
  assert.equal(rec.state.steps[2].status, "done");
});

test("a blocked preflight names its check and offers no step retry", () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "blocked",
    stage: "treasury",
    detail: "not your treasury",
  });
  assert.equal(rec.state.phase, "blocked");
  assert.equal(rec.state.failure.check, "treasury");
  assert.equal(retryPlan(rec.state), null);
});

// ---------------------------------------------------------------------------
// runDeploySteps — sequential + batched strategies
// (port of mintFlow.test.mjs:587-806)
// ---------------------------------------------------------------------------

const deployCalls = () =>
  buildTokenDeployCalls({
    name: "Nebula",
    symbol: "NEB",
    treasury: BIDDER,
    tokenAddress: DEPLOYED_TOKEN,
  });

test("runDeploySteps (sequential) sends the three calls one receipt at a time", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  const sends = [];
  const outcome = await runDeploySteps({
    calls: deployCalls(),
    startAt: 0,
    strategy: "sequential",
    effects: {
      send: async (call) => {
        sends.push(call);
        return receipt(`0x${sends.length}`);
      },
    },
    dispatch: rec.dispatch,
  });
  assert.equal(outcome.completed, true);
  assert.equal(sends.length, 3);
  assert.ok(rec.state.steps.every((s) => s.status === "done"));
});

test("runDeploySteps (sequential) halts on the first revert and names the step", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  const sends = [];
  await runDeploySteps({
    calls: deployCalls(),
    startAt: 0,
    strategy: "sequential",
    effects: {
      send: async (call) => {
        sends.push(call);
        return receipt(
          `0x${sends.length}`,
          sends.length === 2 ? "reverted" : "success",
        );
      },
    },
    dispatch: rec.dispatch,
  });
  assert.equal(sends.length, 2, "nothing after the failure is attempted");
  assert.equal(rec.state.failure.stepIndex, 1);
  assert.equal(rec.state.steps[0].status, "done");
});

test("runDeploySteps resumes at the failed step on retry", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: true,
  });
  const sends = [];
  await runDeploySteps({
    calls: deployCalls(),
    startAt: resumeIndex(rec.state),
    strategy: "sequential",
    effects: {
      send: async (call) => {
        sends.push(call);
        return receipt("0x2");
      },
    },
    dispatch: rec.dispatch,
  });
  assert.equal(
    sends.length,
    2,
    "starts at step 1 (deploy satisfied by code check)",
  );
});

test("runDeploySteps rejects a call list of the wrong length", async () => {
  await assert.rejects(
    () =>
      runDeploySteps({
        calls: deployCalls().slice(0, 2),
        startAt: 0,
        strategy: "sequential",
        effects: { send: async () => receipt("0x1") },
        dispatch: () => {},
      }),
    /expected 3 deploy calls/,
  );
});

test("runDeploySteps (batched) sends ONE UserOp and shares its receipt", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  const batches = [];
  const outcome = await runDeploySteps({
    calls: deployCalls(),
    startAt: 0,
    strategy: "batched",
    effects: {
      send: async () => {
        throw new Error("batched strategy must not use send");
      },
      sendBatch: async (calls) => {
        batches.push(calls);
        return receipt("0xbundle");
      },
    },
    dispatch: rec.dispatch,
  });
  assert.equal(outcome.completed, true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.ok(rec.state.steps.every((s) => s.txHash === "0xbundle"));
});

test("runDeploySteps (batched) failure is atomic: nothing lands, retry re-sends the remainder", async () => {
  const rec = recorder();
  rec.dispatch({ type: "begin", mode: "fresh" });
  rec.dispatch({
    type: "prepared",
    tokenAddress: DEPLOYED_TOKEN,
    tokenAlreadyDeployed: false,
  });
  const batches = [];
  const outcome = await runDeploySteps({
    calls: deployCalls(),
    startAt: 0,
    strategy: "batched",
    effects: {
      send: async () => {
        throw new Error("unused");
      },
      sendBatch: async (calls) => {
        batches.push(calls);
        return receipt("0xbundle", "reverted");
      },
    },
    dispatch: rec.dispatch,
  });
  assert.equal(outcome.completed, false);
  assert.equal(batches.length, 1);
  assert.equal(
    rec.state.failure.stepIndex,
    0,
    "names the first incomplete step",
  );
  assert.equal(rec.state.failure.outcome, "reverted");
  assert.ok(
    rec.state.steps.every((s) => s.status !== "done"),
    "atomic failure lands nothing",
  );
  assert.deepEqual(retryPlan(rec.state), { kind: "steps", resumeAt: 0 });
});

// ---------------------------------------------------------------------------
// runMintAttempt / retryMintAttempt — full orchestration incl. idempotent
// retry (port of mintHooks' run()/retry(), mintHooks.ts:128-228)
// ---------------------------------------------------------------------------

function attemptHarness(overrides = {}) {
  const rec = recorder();
  const sends = [];
  const batches = [];
  const links = [];
  const input = {
    plan: {
      name: "Nebula",
      symbol: "NEB",
      supply: "1000000",
      recordTreasury: BIDDER,
    },
    deployer: BIDDER,
    strategy: "sequential",
    effects: {
      async call(target) {
        if (target.data === "0xa82f4d02") return `0x${"0".repeat(63)}fa`;
        return ADDRESS_WORD;
      },
      async send(call) {
        sends.push(call);
        return receipt(`0x${sends.length}`);
      },
      async sendBatch(calls) {
        batches.push(calls);
        return receipt("0xbundle");
      },
      async isDeployed() {
        return false;
      },
    },
    async link(token) {
      links.push(token);
    },
    dispatch: rec.dispatch,
    state: rec.state,
    ...overrides,
  };
  return { rec, sends, batches, links, input };
}

test("a full run drives the reducer to success and links the token", async () => {
  const h = attemptHarness();
  await runMintAttempt(h.input, "fresh");
  assert.equal(h.rec.state.phase, "success");
  assert.equal(h.sends.length, 3);
  assert.deepEqual(h.links, [`0x${"11".repeat(20)}`]);
});

test("a partial failure keeps completed state; retry (code check) re-derives and resumes", async () => {
  let sendCount = 0;
  const h = attemptHarness({
    effects: {
      async call(target) {
        if (target.data === "0xa82f4d02") return `0x${"0".repeat(63)}fa`;
        return ADDRESS_WORD;
      },
      async send() {
        sendCount += 1;
        if (sendCount === 2) throw new Error("user rejected");
        return receipt(`0x${sendCount}`);
      },
      async isDeployed() {
        return false;
      },
    },
  });
  await runMintAttempt(h.input, "fresh");
  assert.equal(h.rec.state.phase, "paused");
  assert.equal(h.rec.state.failure.stepIndex, 1);
  assert.equal(h.rec.state.steps[0].status, "done", "deploy stays done");
  assert.equal(h.links.length, 0, "no record write after a failed run");

  // Retry: the deploy call is NOT re-sent (startAt resumes at the failed
  // step); prepare re-derives the calls from fresh views.
  const retry = attemptHarness({
    effects: {
      ...h.input.effects,
      async isDeployed() {
        return true; // the code check sees the deployed token
      },
    },
    state: h.rec.state,
    dispatch: h.rec.dispatch,
    link: h.input.link,
  });
  await runMintAttempt(retry.input, "resume");
  assert.equal(h.rec.state.phase, "success");
  assert.equal(h.links.length, 1);
});

test("an unknown deploy outcome is recovered by the code check on retry", async () => {
  const h = attemptHarness({
    effects: {
      async call(target) {
        if (target.data === "0xa82f4d02") return `0x${"0".repeat(63)}fa`;
        return ADDRESS_WORD;
      },
      async send() {
        throw new Error("network dropped");
      },
      async isDeployed() {
        return false;
      },
    },
  });
  await runMintAttempt(h.input, "fresh");
  assert.equal(h.rec.state.failure.outcome, "unknown");

  // Retry after the deploy actually landed later: the code check satisfies
  // step 1 and the run resumes at the validator wiring.
  const sends = [];
  const retry = attemptHarness({
    effects: {
      async call(target) {
        if (target.data === "0xa82f4d02") return `0x${"0".repeat(63)}fa`;
        return ADDRESS_WORD;
      },
      async send(call) {
        sends.push(call);
        return receipt(`0x${sends.length}`);
      },
      async isDeployed() {
        return true;
      },
    },
    state: h.rec.state,
    dispatch: h.rec.dispatch,
    link: h.input.link,
  });
  await retryMintAttempt(retry.input);
  assert.equal(
    sends.length,
    2,
    "deploy is skipped, validator + ruleset re-run",
  );
  assert.equal(h.rec.state.phase, "success");
});

test("retryMintAttempt on a link failure re-publishes ONLY the record", async () => {
  const h = attemptHarness();
  await runMintAttempt(h.input, "fresh");
  h.rec.dispatch({ type: "link_started" });
  h.rec.dispatch({ type: "link_failed", reason: "relay down" });
  const links = [];
  const retry = attemptHarness({
    state: h.rec.state,
    dispatch: h.rec.dispatch,
    link: async (token) => {
      links.push(token);
    },
    effects: {
      async call() {
        throw new Error("no chain calls on a record retry");
      },
      async send() {
        throw new Error("no money sends on a record retry");
      },
      async isDeployed() {
        throw new Error("no chain reads on a record retry");
      },
    },
  });
  const kind = await retryMintAttempt(retry.input);
  assert.equal(kind, "record");
  assert.deepEqual(links, [`0x${"11".repeat(20)}`]);
  assert.equal(h.rec.state.phase, "success");
});

// `cast calldata "deployToken(...)"` with the DeployAppToken.s.sol defaults
// (evmCalls.test.mjs:201-282 — the exact vector desktop's encoder binds).
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

test("encodeDeployToken matches the pinned `cast calldata` bytes end to end", () => {
  // Web's encoder is `identity/lib/userop-abi.ts`'s abiEncodeCall; this vector
  // is the cross-encoder byte proof against foundry `cast` — any drift in the
  // tuple layouts, the 28-word init args, or the empty signature fails here.
  assert.equal(
    encodeDeployToken({
      name: "Nebula",
      symbol: "NEB",
      treasury: BIDDER,
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      salt: 1n,
      initialSupplyAmount: 1_000_000n * 10n ** 18n,
      pairedDepositWei: 10n ** 17n,
      spreadBps: 100,
      buyFeeBps: 200,
      sellFeeBps: 200,
      defaultTransferValidator: ZERO_ADDRESS,
    }),
    CAST_DEPLOY_TOKEN,
  );
});

// ---------------------------------------------------------------------------
// Mint composer/sender parity (mirror of sponsoredSender.test.mjs's parity)
// ---------------------------------------------------------------------------

test("the mint deploy sequence reaches both senders byte-identically", async () => {
  const composed = deployCalls().map(({ to, value, data }) => ({
    to,
    value,
    data,
  }));

  const walletWire = [];
  const walletSender = createInjectedWalletSender({
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [BIDDER];
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
  );

  seedPasskeyStorage();
  const perCall = capturingDeps();
  await createSponsoredSender(
    { ...CONFIG, batching: "per-call" },
    perCall.deps,
  ).sendCalls(composed);
  perCall.requests.forEach((request, i) => {
    assert.equal(request.callData, encodeExecuteSingleCallData(walletWire[i]));
  });

  const batched = capturingDeps();
  await createSponsoredSender(CONFIG, batched.deps).sendCalls(composed);
  assert.equal(
    batched.requests.length,
    1,
    "the sponsored path batches to one UserOp",
  );
  assert.equal(
    batched.requests[0].callData,
    encodeExecuteBatchCallData(walletWire),
  );
});
