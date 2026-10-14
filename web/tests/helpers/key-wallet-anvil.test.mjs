import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import test from "node:test";

import { createKeyWalletProvider, newKeyWallet } from "./key-wallet.ts";

/**
 * The wallet's transactions, against a real Anvil: a transaction this wallet signs has to be one a node accepts, with
 * the right sender, nonce and fees. Skipped when Anvil is not installed.
 */

const PATH = `${process.env.PATH ?? ""}:${homedir()}/.foundry/bin`;

async function startAnvil() {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const child = spawn("anvil", ["--port", String(port), "--silent"], {
    env: { ...process.env, PATH },
    stdio: "ignore",
  });
  const failed = new Promise((resolve) =>
    child.once("error", () => resolve(true)),
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (
      await Promise.race([
        failed,
        new Promise((r) => setTimeout(() => r(false), 100)),
      ])
    ) {
      return null;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (response.ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
  }
  child.kill();
  return null;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

test("a transaction the wallet signs is accepted by a real node, and two in flight take different nonces", async (t) => {
  const anvil = await startAnvil();
  if (!anvil) {
    t.skip("anvil is not installed");
    return;
  }
  try {
    const wallet = newKeyWallet();
    await rpc(anvil.url, "anvil_setBalance", [
      wallet.address,
      "0x56bc75e2d63100000",
    ]); // 100 ETH
    const provider = createKeyWalletProvider(wallet, { rpcUrl: anvil.url });
    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [
      wallet.address,
    ]);

    const recipient = newKeyWallet().address;
    // Both sends are started before either is awaited: the wallet queues them so each takes its own nonce.
    const [first, second] = await Promise.all([
      provider.request({
        method: "eth_sendTransaction",
        params: [
          { from: wallet.address, to: recipient, value: "0xde0b6b3a7640000" },
        ],
      }),
      provider.request({
        method: "eth_sendTransaction",
        params: [
          { from: wallet.address, to: recipient, value: "0xde0b6b3a7640000" },
        ],
      }),
    ]);
    for (const hash of [first, second]) {
      const receipt = await rpc(anvil.url, "eth_getTransactionReceipt", [hash]);
      assert.equal(receipt.status, "0x1");
      assert.equal(
        receipt.from.toLowerCase(),
        wallet.address,
        "the node recovers the wallet as the sender",
      );
    }
    assert.equal(
      BigInt(await rpc(anvil.url, "eth_getBalance", [recipient, "latest"])),
      2n * 10n ** 18n,
    );
    assert.equal(
      await rpc(anvil.url, "eth_getTransactionCount", [
        wallet.address,
        "latest",
      ]),
      "0x2",
    );

    // Contract creation (no `to`): the smallest contract that returns nothing.
    const created = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: wallet.address, data: "0x6001600c60003960016000f300" }],
    });
    const receipt = await rpc(anvil.url, "eth_getTransactionReceipt", [
      created,
    ]);
    assert.equal(receipt.status, "0x1");
    assert.match(receipt.contractAddress, /^0x[0-9a-f]{40}$/);
  } finally {
    anvil.stop();
  }
});
