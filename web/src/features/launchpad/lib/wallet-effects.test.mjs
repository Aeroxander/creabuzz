import assert from "node:assert/strict";
import test from "node:test";

import { makeWalletAuctionEffects, walletError } from "./wallet-effects.ts";

const DEPLOYER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;

/**
 * A scripted EIP-1193 provider: `handlers[method]` is a function (or a queue
 * of results) and every request is recorded, so a test can assert what the
 * wallet was actually asked and in what order.
 */
function fakeProvider(handlers) {
  const log = [];
  return {
    log,
    async request({ method, params }) {
      log.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        throw new Error(`unexpected wallet request ${method}`);
      }
      if (typeof handler === "function") return handler(params);
      if (Array.isArray(handler)) {
        const next = handler.shift();
        if (next instanceof Error || (next && next.code !== undefined)) {
          throw next;
        }
        return next;
      }
      return handler;
    },
  };
}

/** A virtual clock so timeout tests never wait in real time. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function effects(provider, overrides = {}) {
  const c = clock();
  return makeWalletAuctionEffects({
    provider,
    deployer: DEPLOYER,
    chainId: 31337,
    now: c.now,
    sleep: c.sleep,
    ...overrides,
  });
}

test("a contract creation omits `to`, polls to a mined receipt and reports the created address", async () => {
  const created = "0x2222222222222222222222222222222222222222";
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: HASH,
    // Not mined on the first two polls.
    eth_getTransactionReceipt: [
      null,
      null,
      {
        status: "0x1",
        blockNumber: "0x10",
        gasUsed: "0x5208",
        contractAddress: created,
      },
    ],
  });
  const receipt = await effects(provider).send({ data: "0x6080" });

  assert.deepEqual(receipt, {
    txHash: HASH,
    status: "success",
    blockNumber: 16,
    gasUsed: "21000",
    contractAddress: created,
  });
  const sent = provider.log.find((r) => r.method === "eth_sendTransaction");
  assert.equal("to" in sent.params[0], false, "creation is keyed on no `to`");
  assert.equal(sent.params[0].from, DEPLOYER);
  assert.equal(sent.params[0].value, "0x0");
  assert.equal(
    provider.log.filter((r) => r.method === "eth_getTransactionReceipt").length,
    3,
  );
});

test("a call carries `to` and value through unchanged", async () => {
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: HASH,
    eth_getTransactionReceipt: {
      status: "0x1",
      blockNumber: "0x1",
      gasUsed: "0x1",
      contractAddress: null,
    },
  });
  const to = "0x3333333333333333333333333333333333333333";
  const receipt = await effects(provider).send({
    to,
    data: "0xdeadbeef",
    value: "0x10",
  });
  assert.equal(receipt.contractAddress, null);
  const sent = provider.log.find((r) => r.method === "eth_sendTransaction");
  assert.equal(sent.params[0].to, to);
  assert.equal(sent.params[0].value, "0x10");
  assert.equal(sent.params[0].data, "0xdeadbeef");
});

test("a mined revert is data (status reverted), not an exception", async () => {
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: HASH,
    eth_getTransactionReceipt: {
      status: "0x0",
      blockNumber: "0x2",
      gasUsed: "0x100",
    },
  });
  const receipt = await effects(provider).send({ to: DEPLOYER, data: "0x" });
  assert.equal(receipt.status, "reverted");
  assert.equal(receipt.contractAddress, null);
});

test("nothing is sent while the wallet is on the wrong chain", async () => {
  const provider = fakeProvider({ eth_chainId: "0x1" });
  await assert.rejects(
    effects(provider).send({ data: "0x6080" }),
    /wallet is on chain 1, but this launch is on chain 31337/,
  );
  assert.equal(
    provider.log.some((r) => r.method === "eth_sendTransaction"),
    false,
    "a wrong-chain wallet must never be asked to sign",
  );
});

test("the chain is checked once, then trusted for the rest of the flow", async () => {
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: HASH,
    eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1" },
  });
  const e = effects(provider);
  await e.send({ to: DEPLOYER, data: "0x" });
  await e.send({ to: DEPLOYER, data: "0x" });
  assert.equal(
    provider.log.filter((r) => r.method === "eth_chainId").length,
    1,
  );
});

test("a receipt that never arrives rejects at the deadline (bounded), naming the hash", async () => {
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: HASH,
    eth_getTransactionReceipt: null,
  });
  await assert.rejects(
    effects(provider, { pollMs: 1000, timeoutMs: 5000 }).send({
      to: DEPLOYER,
      data: "0x",
    }),
    (error) => {
      assert.match(error.message, new RegExp(HASH));
      assert.match(error.message, /not confirmed within 5s/);
      return true;
    },
  );
  const polls = provider.log.filter(
    (r) => r.method === "eth_getTransactionReceipt",
  ).length;
  assert.ok(polls >= 2 && polls <= 7, `bounded polling, saw ${polls}`);
});

test("a user rejection surfaces as a readable Error, not a bare object", async () => {
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: () => {
      throw { code: 4001, message: "User denied transaction signature" };
    },
  });
  await assert.rejects(effects(provider).send({ data: "0x6080" }), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "You rejected the request in your wallet.");
    return true;
  });
  assert.equal(
    walletError({ code: -32000, message: "nonce too low" }).message,
    "nonce too low",
  );
  assert.equal(walletError("weird").message, "The wallet returned an error.");
});

test("a malformed transaction hash is refused rather than polled", async () => {
  const provider = fakeProvider({
    eth_chainId: "0x7a69",
    eth_sendTransaction: "not-a-hash",
  });
  await assert.rejects(
    effects(provider).send({ data: "0x6080" }),
    /did not return a transaction hash/,
  );
  assert.equal(
    provider.log.some((r) => r.method === "eth_getTransactionReceipt"),
    false,
  );
});

test("reads use the wallet's own node: call, code, nonce, block", async () => {
  const provider = fakeProvider({
    eth_call: `0x${"00".repeat(31)}01`,
    eth_getCode: ["0x6080", "0x", "0x0"],
    eth_getTransactionCount: "0x7",
    eth_blockNumber: "0x64",
  });
  const e = effects(provider);
  assert.equal(
    await e.call({ to: DEPLOYER, data: "0x9e5f2602" }),
    `0x${"00".repeat(31)}01`,
  );
  assert.equal(await e.codeAt(DEPLOYER), true);
  assert.equal(await e.codeAt(DEPLOYER), false, "0x is no code");
  assert.equal(await e.codeAt(DEPLOYER), false, "0x0 is no code");
  assert.equal(await e.transactionCount(), 7n);
  assert.equal(await e.blockNumber(), 100n);
  const nonce = provider.log.find(
    (r) => r.method === "eth_getTransactionCount",
  );
  assert.deepEqual(nonce.params, [DEPLOYER, "latest"]);
  assert.equal(
    provider.log.some((r) => r.method === "eth_chainId"),
    false,
    "reads never need the chain check",
  );
});

test("a non-string read result is an error, never coerced", async () => {
  const provider = fakeProvider({
    eth_call: { nope: true },
    eth_getCode: 5,
    eth_blockNumber: null,
  });
  const e = effects(provider);
  await assert.rejects(e.call({ to: DEPLOYER, data: "0x" }), /non-string/);
  await assert.rejects(e.codeAt(DEPLOYER), /non-string/);
  await assert.rejects(e.blockNumber(), /non-string/);
});
