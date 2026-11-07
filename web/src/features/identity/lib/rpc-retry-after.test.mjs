/**
 * `Retry-After` in the two bounded RPC loops (the bundler transport in `aa.ts`, the chain RPC in `kernel033.ts`).
 *
 * A 429/503 that names a wait makes the next attempt wait at least that long; a wait longer than the loop is willing
 * to make (`MAX_RETRY_AFTER_MS`) stops the loop at once with the terminal error it already had, instead of asking
 * again early. Bound to the production loops through their `fetchImpl` seam.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BundlerRpcError, createBundlerTransport } from "./aa.ts";
import {
  Kernel033ChainRpcError,
  createKernel033ChainRpc,
} from "./kernel033.ts";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const OP = {
  sender: "0x2222222222222222222222222222222222222222",
  nonce: "0x0",
  initCode: "0x",
  callData: "0x",
  accountGasLimits: `0x${"0".repeat(64)}`,
  preVerificationGas: "0x0",
  gasFees: `0x${"0".repeat(64)}`,
  paymasterAndData: "0x",
  signature: "0x",
};

function busy(status, retryAfter, body = "busy") {
  const headers = new Headers();
  if (retryAfter !== null) headers.set("retry-after", retryAfter);
  return new Response(body, { status, headers });
}

function ok(result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sequence(replies) {
  const times = [];
  let index = 0;
  const fetchImpl = async () => {
    times.push(Date.now());
    const next = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return next();
  };
  return { fetchImpl, times };
}

test("bundler: a Retry-After longer than the loop waits stops at once with the terminal error", async () => {
  const { fetchImpl, times } = sequence([() => busy(429, "60")]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    maxAttempts: 3,
    backoffMs: 0,
  });
  await assert.rejects(
    () => transport.sendUserOperation(OP, ENTRY_POINT),
    (error) =>
      error instanceof BundlerRpcError &&
      error.retryable &&
      /HTTP 429/.test(error.message),
  );
  assert.equal(times.length, 1, "no second attempt before the asked wait");
});

test("bundler: the next attempt waits at least the Retry-After it was given", async () => {
  const { fetchImpl, times } = sequence([
    () => busy(503, "1"),
    () => ok("0xabc"),
  ]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    maxAttempts: 2,
    backoffMs: 0,
  });
  assert.equal(await transport.sendUserOperation(OP, ENTRY_POINT), "0xabc");
  assert.equal(times.length, 2);
  assert.ok(
    times[1] - times[0] >= 950,
    `waited ${times[1] - times[0]} ms, the server asked for 1000`,
  );
});

test("bundler: without Retry-After the planned backoff still applies", async () => {
  const { fetchImpl, times } = sequence([
    () => busy(429, null),
    () => ok("0xabc"),
  ]);
  const transport = createBundlerTransport({
    url: "https://bundler.invalid",
    fetchImpl,
    maxAttempts: 2,
    backoffMs: 0,
  });
  assert.equal(await transport.sendUserOperation(OP, ENTRY_POINT), "0xabc");
  assert.equal(times.length, 2);
});

test("chain RPC: a Retry-After longer than the loop waits stops at once with the terminal error", async () => {
  const { fetchImpl, times } = sequence([() => busy(503, "120")]);
  const rpc = createKernel033ChainRpc({
    url: "https://node.invalid",
    fetchImpl,
    maxAttempts: 3,
    backoffMs: 0,
  });
  await assert.rejects(
    () => rpc.getCode("0x2222222222222222222222222222222222222222"),
    (error) =>
      error instanceof Kernel033ChainRpcError &&
      /HTTP 503/.test(error.serverMessage),
  );
  assert.equal(times.length, 1, "no second attempt before the asked wait");
});

test("chain RPC: the next attempt waits at least the Retry-After it was given", async () => {
  const { fetchImpl, times } = sequence([
    () => busy(429, "1"),
    () => ok("0x60"),
  ]);
  const rpc = createKernel033ChainRpc({
    url: "https://node.invalid",
    fetchImpl,
    maxAttempts: 2,
    backoffMs: 0,
  });
  assert.equal(
    await rpc.getCode("0x2222222222222222222222222222222222222222"),
    "0x60",
  );
  assert.equal(times.length, 2);
  assert.ok(
    times[1] - times[0] >= 950,
    `waited ${times[1] - times[0]} ms, the node asked for 1000`,
  );
});
