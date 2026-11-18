import assert from "node:assert/strict";
import test from "node:test";

import { RPC_RETRY, ethBlockNumber } from "./chain.ts";

/** A node reply with real headers, as `fetch` gives one. */
function busy(status, retryAfter) {
  return {
    ok: false,
    status,
    headers: new Headers(
      retryAfter === null ? {} : { "Retry-After": retryAfter },
    ),
    json: async () => ({}),
  };
}

async function withNode(delays, replies, run) {
  const original = globalThis.fetch;
  const saved = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = delays;
  let calls = 0;
  globalThis.fetch = async () => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    return reply;
  };
  try {
    await run(() => calls);
  } finally {
    globalThis.fetch = original;
    RPC_RETRY.delaysMs = saved;
  }
}

test("a busy node is not asked again sooner than its Retry-After", async () => {
  const answer = {
    ok: true,
    status: 200,
    json: async () => ({ result: "0x2a" }),
  };
  await withNode([1], [busy(429, "1"), answer], async (calls) => {
    const started = Date.now();
    assert.equal(await ethBlockNumber("http://node.test"), 42n);
    assert.ok(Date.now() - started >= 900, "waited for the asked second");
    assert.equal(calls(), 2);
  });
});

test("a node that asks for a long wait ends the retries at once, in plain words", async () => {
  await withNode([1, 1], [busy(503, "120")], async (calls) => {
    await assert.rejects(ethBlockNumber("http://node.test"), /node is busy/);
    assert.equal(calls(), 1);
  });
});

test("a busy node without Retry-After keeps the planned pauses", async () => {
  await withNode([1, 1], [busy(503, null)], async (calls) => {
    await assert.rejects(ethBlockNumber("http://node.test"), /node is busy/);
    assert.equal(calls(), 3);
  });
});
