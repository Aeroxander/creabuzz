// scripts/lib/lbamm-replay.mjs — replay the post-deploy steps a Limit Break AMM deploy script prints, on a LOCAL chain.
//
// The deploy script (a `forge script` run) prints two kinds of lines that a real broadcast cannot carry out itself:
//   ETCH label=… to=0x… code=0x…                  put bytecode at an address
//   SEND label=… from=0x… to=0x… data=0x…         send a call as an address that no key is held for
// This reads that output on stdin, does each one against an anvil node (anvil_setCode, and anvil impersonation), and
// prints the DEPLOYMENT_ADDRESSES block as JSON on stdout.
//
// ⚠️  DEV ONLY. It needs anvil's impersonation methods, so it can only ever work on a local test chain.
//
//   forge script … | node scripts/lib/lbamm-replay.mjs <rpc-url>

import { readFileSync } from "node:fs";

const rpcUrl = process.argv[2];
if (!rpcUrl) {
  console.error("usage: lbamm-replay.mjs <rpc-url>  (the forge script output on stdin)");
  process.exit(2);
}

let nextId = 1;
async function rpc(method, params = []) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const fields = (line) =>
  Object.fromEntries(
    line
      .split(/\s+/)
      .map((part) => part.split("="))
      .filter((pair) => pair.length === 2),
  );

const output = readFileSync(0, "utf8");
const lines = output.split("\n");

// Anvil refuses these methods on a node that is not a dev node, which is the point.
const chainId = Number.parseInt(await rpc("eth_chainId"), 16);
const impersonated = new Set();

for (const line of lines) {
  if (/\bETCH\b/.test(line)) {
    const { to, code } = fields(line);
    if (!to || !code) continue;
    await rpc("anvil_setCode", [to, code]);
    console.error(`etch ${to} (${(code.length - 2) / 2} bytes)`);
  }
}

for (const line of lines) {
  if (!/\bSEND\b/.test(line)) continue;
  const { from, to, data } = fields(line);
  if (!from || !to || !data) continue;
  if (!impersonated.has(from)) {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, "0x3635C9ADC5DEA00000"]);
    impersonated.add(from);
  }
  const hash = await rpc("eth_sendTransaction", [{ from, to, data, gas: "0x1c9c380" }]);
  let receipt = null;
  for (let i = 0; i < 100 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) await new Promise((r) => setTimeout(r, 50));
  }
  if (!receipt || receipt.status !== "0x1") {
    throw new Error(`a SEND to ${to} from ${from} did not succeed (tx ${hash})`);
  }
  console.error(`send ${to} from ${from}`);
}
for (const who of impersonated) await rpc("anvil_stopImpersonatingAccount", [who]);

const block = output.split("--- DEPLOYMENT_ADDRESSES ---")[1] ?? "";
const addresses = {};
for (const line of block.split("\n")) {
  const m = line.trim().match(/^([A-Z0-9_]+)=(0x[0-9a-fA-F]{40})$/);
  if (m) addresses[m[1]] = m[2];
}
if (Object.keys(addresses).length === 0) {
  console.error("no DEPLOYMENT_ADDRESSES block in the deploy output");
  process.exit(1);
}
console.log(JSON.stringify({ chainId, ...addresses }));
