import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmGovernanceTransaction,
  sendGovernanceCall,
} from "./governance-send.ts";

const dao = "0x" + "11".repeat(20);
const hash = "0x" + "bb".repeat(32);
const endpoint = "http://governance.test";

test("wallet chain must match the preview; wrong chain never sends a vote", async (t) => {
  const sent = [];
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ result: "0x7a69" })),
  );
  const wallet = {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_sendTransaction") sent.push(params[0]);
      return [dao];
    },
  };
  await assert.rejects(
    sendGovernanceCall(
      { kind: "wallet", wallet, chainId: 31337 },
      endpoint,
      dao,
      "0x1234",
    ),
    /Select chain 31337/,
  );
  assert.equal(sent.length, 0);
});

test("receipt success confirms; reverts and unknown outcomes propagate with the hash", async (t) => {
  let receipt = { status: "0x1" };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ result: receipt })),
  );
  await confirmGovernanceTransaction(endpoint, hash);
  receipt = { status: "0x0" };
  await assert.rejects(
    confirmGovernanceTransaction(endpoint, hash),
    (error) => error.message.includes(hash) && /reverted/.test(error.message),
  );
  receipt = null;
  await assert.rejects(
    confirmGovernanceTransaction(endpoint, hash, { timeoutMs: 0 }),
    (error) =>
      error.message.includes(hash) && /not confirmed/.test(error.message),
  );
});

test("a pending transaction settles once without another wallet send", async (t) => {
  let reads = 0;
  let waits = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ result: ++reads === 1 ? null : { status: "0x1" } }),
      ),
  );
  await confirmGovernanceTransaction(endpoint, hash, {
    sleep: async () => {
      waits++;
    },
  });
  assert.equal(reads, 2);
  assert.equal(waits, 1);
});
