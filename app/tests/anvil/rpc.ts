/**
 * A small JSON-RPC client for the anvil loop, and an EIP-1193 provider per account that forwards to anvil, so the app's
 * own wallet (`src/features/money/wallet.ts`) sends the app's own calls on a real EVM. anvil signs `eth_sendTransaction`
 * for its unlocked development accounts, so no key is handled here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeParameters } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import type { Eip1193Provider } from "../../src/features/money/wallet";

export let RPC = process.env.M7_ANVIL_RPC ?? "";

/** Point the harness at another anvil (a spec that starts its own chain names it here before it sends anything). */
export function pointAtRpc(url: string): void {
  RPC = url;
}

let id = 0;
export async function rpc<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string; data?: unknown };
  };
  if (body.error)
    throw Object.assign(new Error(body.error.message), body.error);
  return body.result as T;
}

/** anvil's development accounts 0 to 9 (public test accounts, never used anywhere real). */
export async function accounts(): Promise<string[]> {
  return (await rpc<string[]>("eth_accounts")).map((a) => a.toLowerCase());
}

/** The provider a browser wallet would be, for `account`. */
export function providerFor(account: string): Eip1193Provider {
  return {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [account];
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_sendTransaction") {
        const tx = (params?.[0] ?? {}) as Record<string, unknown>;
        return rpc(method, [{ ...tx, from: account, gas: "0x1c9c380" }]);
      }
      return rpc(method, params ?? []);
    },
  };
}

const OUT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../contracts/next/out",
);

/** A contract's creation code from the build. */
export function creationCode(artifact: string): string {
  const json = JSON.parse(readFileSync(resolve(OUT, artifact), "utf8")) as {
    bytecode: { object: string };
  };
  return json.bytecode.object;
}

export async function waitReceipt(hash: string) {
  for (let i = 0; i < 100; i += 1) {
    const receipt = await rpc<{
      status: string;
      contractAddress: string | null;
      logs: { address: string; topics: string[]; data: string }[];
    } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no receipt for ${hash}`);
}

/** Send a transaction from an unlocked account and insist it landed. */
export async function send(from: string, to: string | null, data: string) {
  const hash = await rpc<string>("eth_sendTransaction", [
    { from, ...(to ? { to } : {}), data, gas: "0x3938700" },
  ]);
  const receipt = await waitReceipt(hash);
  if (receipt.status !== "0x1")
    throw new Error(`reverted: ${to} ${data.slice(0, 10)}`);
  return receipt;
}

/** Deploy `artifact` with constructor arguments. */
export async function deploy(
  from: string,
  artifact: string,
  types: Parameters<typeof encodeParameters>[0] = [],
  values: Parameters<typeof encodeParameters>[1] = [],
): Promise<string> {
  const args = types.length ? encodeParameters(types, values).slice(2) : "";
  const receipt = await send(from, null, creationCode(artifact) + args);
  if (!receipt.contractAddress) throw new Error(`no address for ${artifact}`);
  return receipt.contractAddress.toLowerCase();
}

export async function call(to: string, data: string): Promise<string> {
  return rpc<string>("eth_call", [{ to, data }, "latest"]);
}

export async function word(to: string, data: string): Promise<bigint> {
  return BigInt((await call(to, data)).slice(0, 66));
}

export async function mine(blocks: number) {
  await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
}

export async function passTime(seconds: number) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

export async function blockNumber(): Promise<number> {
  return Number.parseInt(await rpc<string>("eth_blockNumber"), 16);
}

/** The newest block's time, in seconds: deadlines are set from it, since the scenarios move the chain's clock. */
export async function chainTime(): Promise<number> {
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  return Number.parseInt(block.timestamp, 16);
}
