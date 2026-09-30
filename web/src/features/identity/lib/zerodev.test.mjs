/**
 * ZeroDev hosted bundler + paymaster client tests.
 *
 * Every mocked request/response is pinned to the DISCOVERED wire shapes —
 * never invented (wave 4c anti-hallucination rule). Provenance per test:
 *
 * - RPC URL (`api/v3/<projectId>/chain/<chainId>`, `?apikey=` + `X-API-Key`):
 *   https://docs.zerodev.app/api-and-toolings/infrastructure/rpcs +
 *   live probes with the real project credentials (2026-09-24).
 * - Unpacked v0.7-style userOp wire (no `initCode`/`accountGasLimits`/
 *   `gasFees`/`paymasterAndData` keys): live `eth_estimateUserOperationGas`
 *   probe — unpacked reached simulation (`AA13 initCode failed or OOG`),
 *   packed was rejected with `Validation error: Unrecognized keys:
 *   "initCode", "accountGasLimits", "gasFees", "paymasterAndData"`.
 * - `zd_sponsorUserOperation` request/response shapes: @zerodev/sdk@5.5.10
 *   `types/kernel.ts` `ZeroDevPaymasterRpcSchema` + live probe (`chainId`
 *   must be a number; `maxFeePerGas`/`maxPriorityFeePerGas` required).
 * - paymasterAndData packing (paymaster ‖ u128 ‖ u128 ‖ data):
 *   eth-infinitism UserOperationLib `PAYMASTER_VALIDATION_GAS_OFFSET = 20`,
 *   `PAYMASTER_POSTOP_GAS_OFFSET = 36`, `PAYMASTER_DATA_OFFSET = 52`.
 * - Policy denial UX: https://docs.zerodev.app/api-and-toolings/
 *   infrastructure/gas-policies and /get-started/sdks/setup-project.
 *
 * All I/O is mocked at the injected seams (fetchImpl) so these bind the
 * production code paths without infrastructure (TESTING.md "Review-Proven
 * Test Standards": falsifiable and seam-binding).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BundlerRpcError, createBundlerTransport } from "./aa.ts";
import { getUserOpHash, packAccountGasLimits, packGasFees } from "./userop.ts";
import {
  ENTRY_POINT_V0_8,
  PAYMASTER_DENIED_DASHBOARD_ACTION,
  PaymasterDeniedError,
  ZerodevNotConfiguredError,
  applySponsorship,
  packPaymasterAndData,
  sendSponsoredUserOp,
  sponsorUserOperation,
  toRpcUserOperation,
  zerodevHeaders,
  zerodevRpcUrl,
} from "./zerodev.ts";

const PROJECT_ID = "00000000-0000-4000-8000-00000000beef";
const API_KEY = "fake-test-api-key";
const SENDER = "0x2222222222222222222222222222222222222222";
const FACTORY = "0x1111111111111111111111111111111111111111";
const PAYMASTER = "0x3333333333333333333333333333333333333333";

const config = { projectId: PROJECT_ID, apiKey: API_KEY, chainId: 11155111 };

function skeletonPacked() {
  return {
    sender: SENDER,
    nonce: "0x0",
    initCode: `${FACTORY}aabbccdd`,
    callData: "0xdeadbeef",
    accountGasLimits: packAccountGasLimits({
      verificationGasLimit: 0x30000n,
      callGasLimit: 0x4000n,
    }),
    preVerificationGas: "0x5208",
    gasFees: packGasFees({
      maxPriorityFeePerGas: 0x1n,
      maxFeePerGas: 0x3b9aca00n,
    }),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** Queueing fetch mock; records every request body for golden asserts. */
function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`mockFetch: unexpected call ${body.method}`);
    }
    if (next.__raw !== undefined) {
      return next.__raw;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, ...next }),
    };
  };
  return { fetchImpl, calls };
}

test("zerodevRpcUrl: v3 chain-in-path URL + apikey transport (docs rpcs)", () => {
  assert.equal(
    zerodevRpcUrl(config),
    `https://rpc.zerodev.app/api/v3/${PROJECT_ID}/chain/11155111?apikey=${API_KEY}`,
  );
  assert.deepEqual(zerodevHeaders(config), { "X-API-Key": API_KEY });
  assert.equal(
    zerodevRpcUrl({ projectId: PROJECT_ID, chainId: 11155111 }),
    `https://rpc.zerodev.app/api/v3/${PROJECT_ID}/chain/11155111`,
  );
});

test("zerodevRpcUrl: unconfigured project/chain throws typed error", () => {
  assert.throws(() => zerodevRpcUrl({}), ZerodevNotConfiguredError);
  assert.throws(
    () => zerodevRpcUrl({ projectId: PROJECT_ID }),
    ZerodevNotConfiguredError,
  );
});

test("toRpcUserOperation: unpacked v0.7 wire golden (live probe shapes)", () => {
  const rpc = toRpcUserOperation(skeletonPacked());
  assert.deepEqual(rpc, {
    sender: SENDER,
    nonce: "0x0",
    factory: FACTORY,
    factoryData: "0xaabbccdd",
    callData: "0xdeadbeef",
    callGasLimit: "0x4000",
    verificationGasLimit: "0x30000",
    preVerificationGas: "0x5208",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
    signature: "0x",
  });
  // The packed keys the gateway rejects must be absent (live probe).
  for (const key of [
    "initCode",
    "accountGasLimits",
    "gasFees",
    "paymasterAndData",
  ]) {
    assert.equal(key in rpc, false, `wire op must not carry ${key}`);
  }
});

test("packPaymasterAndData: v0.7 offsets 20/36/52 golden (UserOperationLib)", () => {
  const packed = packPaymasterAndData({
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x30000",
    paymasterPostOpGasLimit: "0x10000",
    paymasterData: "0xaabb",
  });
  assert.equal(
    packed,
    "0x" +
      "33".repeat(20) + // paymaster (20 bytes)
      "0".repeat(27) +
      "30000" + // u128 paymasterVerificationGasLimit (16 bytes)
      "0".repeat(27) +
      "10000" + // u128 paymasterPostOpGasLimit (16 bytes)
      "aabb", // paymasterData
  );
  // Round-trips through the wire splitter.
  const rpc = toRpcUserOperation({
    ...skeletonPacked(),
    paymasterAndData: packed,
  });
  assert.equal(rpc.paymaster, PAYMASTER);
  assert.equal(rpc.paymasterVerificationGasLimit, "0x30000");
  assert.equal(rpc.paymasterPostOpGasLimit, "0x10000");
  assert.equal(rpc.paymasterData, "0xaabb");
});

test("applySponsorship: paymaster fields + gas/fees folded into the signed op", () => {
  const sponsored = applySponsorship(skeletonPacked(), {
    preVerificationGas: "0x6000",
    verificationGasLimit: "0x45000",
    callGasLimit: "0x9000",
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x30000",
    paymasterPostOpGasLimit: "0x10000",
    paymasterData: "0xaabb",
  });
  const rpc = toRpcUserOperation(sponsored);
  assert.equal(rpc.preVerificationGas, "0x6000");
  assert.equal(rpc.verificationGasLimit, "0x45000");
  assert.equal(rpc.callGasLimit, "0x9000");
  assert.equal(rpc.paymaster, PAYMASTER);
  // Fees fall back to the pre-sponsorship ceiling when not overridden.
  assert.equal(rpc.maxFeePerGas, "0x3b9aca00");
  assert.equal(rpc.maxPriorityFeePerGas, "0x1");
});

test("sponsorUserOperation: zd_sponsorUserOperation request/response golden (SDK schema)", async () => {
  const sponsorship = {
    preVerificationGas: "0x6000",
    verificationGasLimit: "0x45000",
    callGasLimit: "0x9000",
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x30000",
    paymasterPostOpGasLimit: "0x10000",
    paymasterData: "0xaabb",
  };
  const { fetchImpl, calls } = mockFetch([{ result: sponsorship }]);
  const userOp = toRpcUserOperation(skeletonPacked());
  const result = await sponsorUserOperation(
    { ...config, fetchImpl, maxAttempts: 1 },
    { chainId: 11155111, userOp, entryPointAddress: ENTRY_POINT_V0_8 },
  );
  assert.deepEqual(result, sponsorship);
  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "zd_sponsorUserOperation",
    params: [
      {
        chainId: 11155111,
        userOp,
        entryPointAddress: ENTRY_POINT_V0_8,
        shouldOverrideFee: false,
        manualGasEstimation: false,
        shouldConsume: true,
      },
    ],
  });
  assert.match(calls[0].url, /\/api\/v3\/[^/]+\/chain\/11155111\?apikey=/);
});

test("sponsorUserOperation: policy denial → PaymasterDeniedError with server text + dashboard action (gas-policies docs)", async () => {
  const { fetchImpl } = mockFetch([
    {
      error: {
        code: -32000,
        message: "policy violation: transaction not allowed by gas policies",
      },
    },
  ]);
  await assert.rejects(
    sponsorUserOperation(
      { ...config, fetchImpl, maxAttempts: 1 },
      {
        chainId: 11155111,
        userOp: toRpcUserOperation(skeletonPacked()),
        entryPointAddress: ENTRY_POINT_V0_8,
      },
    ),
    (error) => {
      assert.ok(error instanceof PaymasterDeniedError);
      assert.equal(
        error.serverMessage,
        "policy violation: transaction not allowed by gas policies",
      );
      assert.equal(error.dashboardAction, PAYMASTER_DENIED_DASHBOARD_ACTION);
      // Rule 1: the raw server message survives into the thrown error text.
      assert.match(error.message, /transaction not allowed by gas policies/);
      return true;
    },
  );
});

test("sponsorUserOperation: HTTP 400 body is surfaced verbatim (Rule 1: simulation/policy text lives in the body)", async () => {
  const body =
    '{"error":"UserOperation reverted during simulation with reason: AA13 initCode failed or OOG"}';
  const { fetchImpl } = mockFetch([
    {
      __raw: {
        ok: false,
        status: 400,
        text: async () => body,
        json: async () => JSON.parse(body),
      },
    },
  ]);
  await assert.rejects(
    sponsorUserOperation(
      { ...config, fetchImpl, maxAttempts: 1 },
      {
        chainId: 11155111,
        userOp: toRpcUserOperation(skeletonPacked()),
        entryPointAddress: ENTRY_POINT_V0_8,
      },
    ),
    (error) => {
      assert.ok(error instanceof BundlerRpcError);
      assert.ok(!(error instanceof PaymasterDeniedError)); // AA13 ≠ denial
      assert.match(error.message, /AA13 initCode failed or OOG/);
      return true;
    },
  );
});

test("sponsorUserOperation: non-policy RPC errors stay BundlerRpcError (Rule 1: no relabeling)", async () => {
  const { fetchImpl } = mockFetch([
    { error: { code: -32603, message: "internal boo-boo 42" } },
  ]);
  await assert.rejects(
    sponsorUserOperation(
      { ...config, fetchImpl, maxAttempts: 1 },
      {
        chainId: 11155111,
        userOp: toRpcUserOperation(skeletonPacked()),
        entryPointAddress: ENTRY_POINT_V0_8,
      },
    ),
    (error) => {
      assert.ok(error instanceof BundlerRpcError);
      assert.ok(!(error instanceof PaymasterDeniedError));
      assert.match(error.message, /internal boo-boo 42/);
      return true;
    },
  );
});

test("sendSponsoredUserOp: sponsor → sign final hash → submit → receipt (production seam)", async () => {
  const sponsorship = {
    preVerificationGas: "0x6000",
    verificationGasLimit: "0x45000",
    callGasLimit: "0x9000",
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x30000",
    paymasterPostOpGasLimit: "0x10000",
    paymasterData: "0xaabb",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  };
  // Real wire shape (ERC-4337 bundler RPC spec; live-verified against
  // ZeroDev's bundler 2026-09-24): the transaction hash / block live under
  // the NESTED `receipt` (standard eth_getTransactionReceipt object).
  const receipt = {
    userOpHash: "0x00",
    sender: SENDER,
    nonce: "0x0",
    actualGasCost: "0x12",
    actualGasUsed: "0x13",
    paymaster: PAYMASTER,
    logs: [],
    receipt: {
      transactionHash: "0x99",
      blockNumber: "0x10",
      blockHash: "0x11",
      status: "0x1",
    },
    success: true,
  };
  // The signer asserts it receives the FINAL (post-sponsorship) hash; the
  // send mock returns exactly that hash so the transport check passes.
  let signedHash;
  const signUserOpHash = (hash) => {
    signedHash = hash;
    return "0xaabbccdd";
  };
  // Pre-compute the hash the production code must reach: skeleton (gas
  // omitted → paymaster estimates) → applySponsorship → getUserOpHash
  // (EntryPoint v0.8.0 EIP-712).
  const expectedSponsored = applySponsorship(skeletonPacked(), sponsorship);
  const expectedHash = getUserOpHash(
    expectedSponsored,
    ENTRY_POINT_V0_8,
    11155111n,
  );

  const { fetchImpl, calls } = mockFetch([
    { result: sponsorship },
    { result: expectedHash },
    { result: null },
    { result: receipt },
  ]);
  const result = await sendSponsoredUserOp({
    config: { ...config, fetchImpl, maxAttempts: 1 },
    entryPointAddress: ENTRY_POINT_V0_8,
    sender: SENDER,
    nonce: "0x0",
    initCode: `${FACTORY}aabbccdd`,
    callData: "0xdeadbeef",
    fees: { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1" },
    dummySignature: "0xdd",
    signUserOpHash,
    receipt: { pollIntervalMs: 1, maxPolls: 5 },
  });

  // Signer bound to the FINAL hash (after sponsorship fields landed).
  assert.equal(signedHash, expectedHash);
  assert.equal(result.opHash, expectedHash);
  assert.equal(result.rpcUserOperation.signature, "0xaabbccdd");
  assert.deepEqual(result.receipt, receipt);
  // Consumers (e.g. zerodev-smoke.mjs) read the tx hash from the NESTED
  // receipt — pin that seam so a wire-shape drift fails here first.
  assert.equal(result.receipt.receipt.transactionHash, "0x99");

  // Method order pinned to the discovered RPC method names.
  assert.deepEqual(
    calls.map((call) => call.body.method),
    [
      "zd_sponsorUserOperation",
      "eth_sendUserOperation",
      "eth_getUserOperationReceipt",
      "eth_getUserOperationReceipt",
    ],
  );
  // Sponsor request: schema `PartialBy` — gas limits omitted for the
  // paymaster's estimation, fees + dummy signature present.
  const sponsored = calls[0].body.params[0];
  assert.equal(sponsored.manualGasEstimation, false);
  for (const key of [
    "preVerificationGas",
    "verificationGasLimit",
    "callGasLimit",
  ]) {
    assert.equal(key in sponsored.userOp, false, `sponsor op omits ${key}`);
  }
  assert.equal(sponsored.userOp.signature, "0xdd");
  // The wire op on the wire is the unpacked shape with the paymaster data.
  const sent = calls[1].body.params[0];
  assert.equal(sent.paymaster, PAYMASTER);
  assert.equal(sent.signature, "0xaabbccdd");
  assert.equal(sent.factory, FACTORY);
  for (const key of [
    "initCode",
    "accountGasLimits",
    "gasFees",
    "paymasterAndData",
  ]) {
    assert.equal(key in sent, false, `wire op must not carry ${key}`);
  }
  assert.equal(calls[2].body.params[0], expectedHash);
});

test("sendSponsoredUserOp: receipt polling is bounded (Rule 4)", async () => {
  const sponsorship = {
    preVerificationGas: "0x6000",
    verificationGasLimit: "0x45000",
    callGasLimit: "0x9000",
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x30000",
    paymasterPostOpGasLimit: "0x10000",
    paymasterData: "0xaabb",
  };
  const { fetchImpl } = mockFetch([
    { result: sponsorship },
    { result: "0x" + "12".repeat(32) },
    { result: null },
    { result: null },
    { result: null },
    { result: null },
  ]);
  await assert.rejects(
    sendSponsoredUserOp({
      config: { ...config, fetchImpl, maxAttempts: 1 },
      entryPointAddress: ENTRY_POINT_V0_8,
      sender: SENDER,
      nonce: "0x0",
      initCode: "0x",
      callData: "0x",
      fees: { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1" },
      dummySignature: "0xdd",
      signUserOpHash: () => "0xaabbccdd",
      // Fixed hash port so the send mock can echo the exact op hash.
      hashUserOp: () => "0x" + "12".repeat(32),
      receipt: { pollIntervalMs: 1, maxPolls: 2 },
    }),
    /after 2 polls/,
  );
});

test("createBundlerTransport: userOpEncoder seam carries the wire shape (production path)", async () => {
  const { fetchImpl, calls } = mockFetch([{ result: "0x" + "34".repeat(32) }]);
  const transport = createBundlerTransport({
    url: "https://rpc.zerodev.app/api/v3/test/chain/1",
    fetchImpl,
    maxAttempts: 1,
    userOpEncoder: toRpcUserOperation,
  });
  await transport.sendUserOperation(skeletonPacked(), ENTRY_POINT_V0_8);
  assert.equal(calls[0].body.params[0].factory, FACTORY);
  assert.equal("initCode" in calls[0].body.params[0], false);
});
