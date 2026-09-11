import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBool,
  decodeUint256,
  DEFAULT_RPC_ENDPOINT,
  hexToBigInt,
  RpcChainAdapter,
  SELECTOR_CURRENCY_RAISED,
  SELECTOR_IS_GRADUATED,
  TOPIC_BID_SUBMITTED,
} from "./chainRpc.ts";

test("selectors are 4-byte function selectors", () => {
  for (const selector of [SELECTOR_IS_GRADUATED, SELECTOR_CURRENCY_RAISED]) {
    assert.match(selector, /^0x[0-9a-f]{8}$/);
  }
  assert.equal(SELECTOR_IS_GRADUATED, "0x9e5f2602");
  assert.equal(SELECTOR_CURRENCY_RAISED, "0x998ba4fc");
  assert.equal(
    TOPIC_BID_SUBMITTED,
    "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540",
  );
});

test("hexToBigInt decodes bounds", () => {
  assert.equal(hexToBigInt("0x0"), 0n);
  assert.equal(hexToBigInt("0xff"), 255n);
  assert.throws(() => hexToBigInt("zz"), /not hex/);
  assert.throws(() => hexToBigInt("0x"), /empty/);
  assert.throws(() => hexToBigInt(`0x${"ff".repeat(33)}`), /overflow/);
});

test("decodeUint256 requires 32 bytes", () => {
  assert.equal(decodeUint256(`0x${"0".repeat(62)}ff`), 255n);
  assert.throws(() => decodeUint256("0x1234"), /32-byte/);
});

test("decodeBool treats nonzero as true", () => {
  assert.equal(decodeBool(`0x${"0".repeat(64)}`), false);
  assert.equal(decodeBool(`0x${"0".repeat(63)}1`), true);
});

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const handler = routes[body.method];
    const result =
      typeof handler === "function" ? handler(body.params) : handler;
    if (result instanceof Error) throw result;
    return { ok: true, json: async () => ({ result }) };
  };
  return calls;
}

function record(overrides = {}) {
  return {
    id: "nebula",
    author: "a".repeat(64),
    auction: "0x1234567890123456789012345678901234567890",
    floorPrice: "100",
    requiredRaised: "1000",
    claimBlock: null,
    ...overrides,
  };
}

test("RpcChainAdapter reads graduation and raised", async () => {
  const orig = globalThis.fetch;
  try {
    stubFetch({
      eth_call: ([call]) =>
        call.data === SELECTOR_IS_GRADUATED
          ? `0x${"0".repeat(63)}1`
          : `0x${"0".repeat(61)}1f4`,
      eth_blockNumber: "0x64",
      eth_getLogs: [],
    });
    const adapter = new RpcChainAdapter("http://localhost:8545");
    const progress = await adapter.getAuctionProgress(record());
    assert.equal(progress.source, "rpc");
    assert.equal(progress.graduated, true);
    assert.equal(progress.ended, true);
    assert.equal(progress.raised, 500n);
    assert.equal(progress.goal, 1000n);
  } finally {
    globalThis.fetch = orig;
  }
});

test("RpcChainAdapter throws without an auction contract", async () => {
  const adapter = new RpcChainAdapter("http://localhost:8545");
  await assert.rejects(
    () => adapter.getAuctionProgress(record({ auction: null })),
    /no auction/,
  );
});

test("RpcChainAdapter throws when the RPC is unreachable", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("down");
    };
    const adapter = new RpcChainAdapter("http://localhost:8545");
    await assert.rejects(() => adapter.getAuctionProgress(record()), /down/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("RpcChainAdapter still returns core numbers when logs fail", async () => {
  const orig = globalThis.fetch;
  try {
    stubFetch({
      eth_call: () => `0x${"0".repeat(64)}`,
      eth_blockNumber: "0x1",
      eth_getLogs: new Error("no logs"),
    });
    const adapter = new RpcChainAdapter("http://localhost:8545");
    const progress = await adapter.getAuctionProgress(record());
    assert.equal(progress.bidCount, 0);
    assert.equal(progress.graduated, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("default endpoint targets local Anvil", () => {
  assert.equal(DEFAULT_RPC_ENDPOINT, "http://127.0.0.1:8545");
});
