/**
 * Transport tests: the bounded bundler RPC client and the `getSenderAddress`
 * revert flow.
 *
 * All I/O is mocked at the injected seams (EthCall,
 * fetchImpl) so these bind the production code paths without infrastructure
 * (TESTING.md "Review-Proven Test Standards": falsifiable and seam-binding).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BundlerNotConfiguredError,
  BundlerRpcError,
  BundlerTimeoutError,
  EthCallRevertError,
  createBundlerTransport,
  getSenderAddress,
} from "./aa.ts";
import { packUints } from "./userop.ts";

const goldenOp = {
  sender: "0x2222222222222222222222222222222222222222",
  nonce: "0x0",
  initCode: "0xdeadbeef",
  callData: "0xc0ffee",
  accountGasLimits: packUints(3n, 5n),
  preVerificationGas: "0x5208",
  gasFees: packUints(1n, 2n),
  paymasterAndData: "0x",
  signature: "0x11",
};
const ENTRY_POINT = "0x1111111111111111111111111111111111111111";

test("getSenderAddress parses the SenderAddressResult revert", async () => {
  const sender = `0x${"22".repeat(20)}`;
  const revertData = `0x6ca7b806${"00".repeat(12)}${"22".repeat(20)}`;
  const call = async ({ to, data }) => {
    assert.equal(to, ENTRY_POINT);
    // getSenderAddress(bytes) selector + offset + length + payload.
    assert.ok(data.startsWith("0x9b249f69"));
    throw new EthCallRevertError("reverted", revertData);
  };
  assert.equal(
    await getSenderAddress({
      call,
      entryPoint: ENTRY_POINT,
      initCode: "0x0102",
    }),
    sender,
  );
  // Wrong revert payload: loud failure.
  await assert.rejects(
    () =>
      getSenderAddress({
        call: async () => {
          throw new EthCallRevertError("reverted", "0xdeadbeef");
        },
        entryPoint: ENTRY_POINT,
        initCode: "0x0102",
      }),
    /not SenderAddressResult/,
  );
  // A non-reverting call means we are not talking to an EntryPoint.
  await assert.rejects(
    () =>
      getSenderAddress({
        call: async () => "0x",
        entryPoint: ENTRY_POINT,
        initCode: "0x",
      }),
    /instead of reverting/,
  );
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function recorder(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof next === "function" ? next(init) : next;
  };
  return { fetchImpl, calls };
}

test("bundler transport rejects with BundlerNotConfiguredError when no URL is set", async () => {
  const transport = createBundlerTransport({
    fetchImpl: async () => jsonResponse({}),
  });
  await assert.rejects(
    () => transport.sendUserOperation(goldenOp, ENTRY_POINT),
    (error) => error instanceof BundlerNotConfiguredError,
  );
  await assert.rejects(
    () => transport.getUserOperationReceipt("0xabc"),
    (error) => error instanceof BundlerNotConfiguredError,
  );
});

test("bundler transport sends JSON-RPC and returns results", async () => {
  const { fetchImpl, calls } = recorder([jsonResponse({ result: "0xabc" })]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    backoffMs: 0,
  });
  assert.equal(transport.url, "https://bundler.invalid");
  assert.equal(
    await transport.sendUserOperation(goldenOp, ENTRY_POINT),
    "0xabc",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bundler.invalid");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendUserOperation",
    params: [goldenOp, ENTRY_POINT],
  });

  const gas = recorder([
    jsonResponse({ result: { preVerificationGas: "0x1" } }),
  ]);
  const gasTransport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl: gas.fetchImpl,
    backoffMs: 0,
  });
  assert.deepEqual(
    await gasTransport.estimateUserOperationGas(goldenOp, ENTRY_POINT),
    {
      preVerificationGas: "0x1",
    },
  );
  assert.equal(gas.calls[0].body.method, "eth_estimateUserOperationGas");

  const receipt = recorder([jsonResponse({ result: null })]);
  const receiptTransport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl: receipt.fetchImpl,
    backoffMs: 0,
  });
  assert.equal(await receiptTransport.getUserOperationReceipt("0xabc"), null);
  assert.deepEqual(receipt.calls[0].body.params, ["0xabc"]);
});

test("bundler transport retries transient HTTP failures with bounded backoff", async () => {
  const { fetchImpl, calls } = recorder([
    { ok: false, status: 503, json: async () => ({}) },
    { ok: false, status: 429, json: async () => ({}) },
    jsonResponse({ result: "0xabc" }),
  ]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    maxAttempts: 3,
    backoffMs: 0,
  });
  assert.equal(
    await transport.sendUserOperation(goldenOp, ENTRY_POINT),
    "0xabc",
  );
  assert.equal(calls.length, 3);
});

test("bundler transport reaches a terminal error after maxAttempts (no endless retry)", async () => {
  const { fetchImpl, calls } = recorder([
    () => Promise.reject(new TypeError("network down")),
  ]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    maxAttempts: 2,
    backoffMs: 0,
  });
  await assert.rejects(
    () => transport.sendUserOperation(goldenOp, ENTRY_POINT),
    (error) =>
      error instanceof BundlerRpcError && /network down/.test(error.message),
  );
  assert.equal(calls.length, 2);
});

test("bundler transport does not retry JSON-RPC or non-retryable HTTP errors", async () => {
  const rpcError = recorder([
    jsonResponse({ error: { code: -32000, message: "AA24 signature error" } }),
  ]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl: rpcError.fetchImpl,
    maxAttempts: 3,
    backoffMs: 0,
  });
  await assert.rejects(
    () => transport.sendUserOperation(goldenOp, ENTRY_POINT),
    (error) => error instanceof BundlerRpcError && error.code === -32000,
  );
  assert.equal(rpcError.calls.length, 1);

  const httpError = recorder([
    { ok: false, status: 400, json: async () => ({}) },
  ]);
  const transport400 = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl: httpError.fetchImpl,
    maxAttempts: 3,
    backoffMs: 0,
  });
  await assert.rejects(
    () => transport400.sendUserOperation(goldenOp, ENTRY_POINT),
    /HTTP 400/,
  );
  assert.equal(httpError.calls.length, 1);
});

test("bundler transport times out per attempt with a typed error", async () => {
  const hanging = (init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const { fetchImpl, calls } = recorder([hanging]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    maxAttempts: 1,
    timeoutMs: 5,
    backoffMs: 0,
  });
  await assert.rejects(
    () => transport.sendUserOperation(goldenOp, ENTRY_POINT),
    (error) => error instanceof BundlerTimeoutError,
  );
  assert.equal(calls.length, 1);
});
