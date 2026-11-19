/**
 * A stand-in for the hosted bundler and sponsor, a small HTTP server in Node (no `cast`) for the phone loop on anvil.
 * The app's own code builds, hashes and signs each operation; this answers the calls it makes to the services an operator
 * runs, against the real EntryPoint v0.7 on the local chain:
 *
 * - `zd_sponsorUserOperation`: runs the account's calls as EntryPoint would (an account that exists), refuses one that
 *   would fail, applies the operator's policy (a test's function), then answers with fixed gas and the chain's
 *   `AcceptAllPaymaster`, which pays from its deposit at EntryPoint;
 * - `eth_sendUserOperation`: the operation in a `handleOps` transaction from an unlocked account, as a bundler does; the
 *   hash returned is EntryPoint's own `getUserOpHash`;
 * - `eth_getUserOperationReceipt` / `eth_getUserOperationByHash`: read back from that transaction.
 *
 * It sends CORS headers so a page can talk to it later. What a hosted service does that this does not (its gas
 * estimates, its policy wording, its rate limits) is exactly what a run against the real one is for.
 */
import { createServer, type Server } from "node:http";
import {
  type AbiField,
  abiEncodeCall,
} from "../../../packages/creaton-core/src/aa/userop-abi.ts";
import { keccak256 } from "../../../packages/creaton-core/src/aa/userop.ts";

export const ENTRY_POINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const OP_TYPE =
  "(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)";

/** The operation as the hosted service's wire carries it (unpacked). */
export interface WireUserOp {
  sender: string;
  nonce: string;
  factory?: string;
  factoryData?: string;
  callData: string;
  callGasLimit?: string;
  verificationGasLimit?: string;
  preVerificationGas?: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
}

export interface SentOp {
  hash: string;
  sender: string;
  nonce: bigint;
  op: WireUserOp;
  /** The transaction that carried it, once mined. */
  txHash: string | null;
}

export interface StandInOptions {
  rpcUrl: string;
  paymaster: string;
  /** An unlocked account with coin that sends each `handleOps`. */
  submitter: string;
  /** Refuse to sponsor an operation whose account calls would fail now (default true, as the hosted service does). */
  simulate?: boolean;
  /** The operator's policy: words to refuse with (the sponsor's own words), or null to sponsor. Gets how many were sponsored before. */
  sponsorPolicy?: (op: WireUserOp, sponsoredBefore: number) => string | null;
  port?: number;
}

export interface StandInBundler {
  url: string;
  /** Every operation accepted, in order. */
  sent: SentOp[];
  /** Every method asked of it, in order, with the URL path it came on. */
  asked: { method: string; path: string }[];
  /** Operations sponsored so far. */
  sponsored(): number;
  /** Turn the check of an account's calls before sponsoring on or off. */
  simulateCalls(on: boolean): void;
  /** While on, an operation is accepted and known by hash but not sent to the chain (it waits in the pool). */
  hold(on: boolean): void;
  /** Forget a held operation: it is gone from the pool and never mined. */
  drop(hash: string): void;
  /** Send every held operation to the chain now. */
  release(): Promise<void>;
  close(): Promise<void>;
}

const word16 = (value: string | undefined) =>
  BigInt(value ?? "0x0")
    .toString(16)
    .padStart(32, "0");
const body = (hex: string | undefined) => (hex ?? "0x").replace(/^0x/, "");

/** The packed operation as the ABI encoder takes the struct. */
function packedFields(op: WireUserOp): AbiField[] {
  const initCode = op.factory
    ? `0x${body(op.factory)}${body(op.factoryData)}`
    : "0x";
  const paymasterAndData = op.paymaster
    ? `0x${body(op.paymaster)}${word16(op.paymasterVerificationGasLimit)}${word16(op.paymasterPostOpGasLimit)}${body(op.paymasterData)}`
    : "0x";
  return [
    { kind: "address", value: op.sender },
    { kind: "uint", value: BigInt(op.nonce) },
    { kind: "bytes", value: initCode },
    { kind: "bytes", value: op.callData },
    {
      kind: "bytes32",
      value: `0x${word16(op.verificationGasLimit)}${word16(op.callGasLimit)}`,
    },
    { kind: "uint", value: BigInt(op.preVerificationGas ?? "0x0") },
    {
      kind: "bytes32",
      value: `0x${word16(op.maxPriorityFeePerGas)}${word16(op.maxFeePerGas)}`,
    },
    { kind: "bytes", value: paymasterAndData },
    { kind: "bytes", value: op.signature },
  ];
}

const eventTopic = keccak256(
  `0x${Buffer.from("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)").toString("hex")}`,
);

export async function startStandInBundler(
  options: StandInOptions,
): Promise<StandInBundler> {
  let simulate = options.simulate ?? true;
  const sent: SentOp[] = [];
  const asked: { method: string; path: string }[] = [];
  let sponsored = 0;
  let holding = false;
  const held = new Set<string>();

  const chain = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const payload = (await res.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (payload.error) throw new Error(payload.error.message);
    return payload.result as T;
  };

  const opHashOf = async (op: WireUserOp): Promise<string> =>
    await chain<string>("eth_call", [
      {
        to: ENTRY_POINT_V07,
        data: abiEncodeCall(`getUserOpHash(${OP_TYPE})`, [
          { kind: "tuple", fields: packedFields(op) },
        ]),
      },
      "latest",
    ]);

  const submit = async (entry: SentOp): Promise<void> => {
    const data = abiEncodeCall(`handleOps(${OP_TYPE}[],address)`, [
      { kind: "tuple[]", items: [packedFields(entry.op)] },
      { kind: "address", value: options.submitter },
    ]);
    const tx = await chain<string>("eth_sendTransaction", [
      {
        from: options.submitter,
        to: ENTRY_POINT_V07,
        data,
        gas: "0x1c9c380",
      },
    ]);
    for (let i = 0; i < 200; i += 1) {
      const receipt = await chain<{ status: string } | null>(
        "eth_getTransactionReceipt",
        [tx],
      );
      if (receipt) {
        if (receipt.status !== "0x1")
          throw new Error(`handleOps failed in ${tx}`);
        entry.txHash = tx;
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no receipt for ${tx}`);
  };

  const receiptOf = async (hash: string) => {
    const entry = sent.find((s) => s.hash === hash.toLowerCase());
    if (!entry?.txHash) return null;
    const tx = await chain<{
      blockNumber: string;
      blockHash: string;
      transactionHash: string;
      logs: { topics: string[]; data: string }[];
    }>("eth_getTransactionReceipt", [entry.txHash]);
    const log = tx.logs.find(
      (l) => l.topics[0] === eventTopic && l.topics[1] === entry.hash,
    );
    if (!log) return null;
    const words = log.data.slice(2).match(/.{64}/g) ?? [];
    return {
      userOpHash: entry.hash,
      entryPoint: ENTRY_POINT_V07,
      sender: entry.sender,
      nonce: `0x${BigInt(`0x${words[0]}`).toString(16)}`,
      paymaster: `0x${log.topics[3].slice(26)}`,
      actualGasCost: `0x${BigInt(`0x${words[2]}`).toString(16)}`,
      actualGasUsed: `0x${BigInt(`0x${words[3]}`).toString(16)}`,
      success: BigInt(`0x${words[1]}`) === 1n,
      logs: tx.logs,
      receipt: tx,
    };
  };

  const answer = async (request: {
    method: string;
    params: unknown[];
  }): Promise<unknown> => {
    switch (request.method) {
      case "eth_chainId":
        return chain("eth_chainId", []);
      case "eth_supportedEntryPoints":
        return [ENTRY_POINT_V07];
      case "zd_sponsorUserOperation": {
        const { userOp } = request.params[0] as { userOp: WireUserOp };
        const refusal = options.sponsorPolicy?.(userOp, sponsored) ?? null;
        if (refusal) throw new Error(refusal);
        const code = await chain<string>("eth_getCode", [
          userOp.sender,
          "latest",
        ]);
        if (simulate && code.length > 2) {
          try {
            await chain("eth_call", [
              {
                from: ENTRY_POINT_V07,
                to: userOp.sender,
                data: userOp.callData,
              },
              "latest",
            ]);
          } catch (error) {
            throw new Error(
              `UserOperation reverted during simulation: ${(error as Error).message}`,
            );
          }
        }
        sponsored += 1;
        return {
          preVerificationGas: "0x30d40",
          verificationGasLimit: "0x2dc6c0",
          callGasLimit: "0x989680",
          paymaster: options.paymaster,
          paymasterVerificationGasLimit: "0x186a0",
          paymasterPostOpGasLimit: "0x0",
          paymasterData: "0x",
        };
      }
      case "eth_sendUserOperation": {
        const op = request.params[0] as WireUserOp;
        const hash = (await opHashOf(op)).toLowerCase();
        const entry: SentOp = {
          hash,
          sender: op.sender.toLowerCase(),
          nonce: BigInt(op.nonce) & ((1n << 64n) - 1n),
          op,
          txHash: null,
        };
        sent.push(entry);
        if (holding) held.add(hash);
        else await submit(entry);
        return hash;
      }
      case "eth_getUserOperationReceipt":
        return receiptOf(String(request.params[0]));
      case "eth_getUserOperationByHash": {
        const hash = String(request.params[0]).toLowerCase();
        const entry = sent.find((s) => s.hash === hash);
        if (!entry) return null;
        const mined = entry.txHash !== null;
        return {
          userOperation: entry.op,
          entryPoint: ENTRY_POINT_V07,
          transactionHash: entry.txHash,
          blockNumber: mined ? "0x1" : null,
        };
      }
      default:
        throw new Error(`method not found: ${request.method}`);
    }
  };

  const server: Server = createServer((req, res) => {
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-api-key",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers).end();
      return;
    }
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const reply = (payload: unknown) => {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let request: { id?: number; method: string; params: unknown[] };
      try {
        request = JSON.parse(text);
      } catch {
        res.writeHead(400, headers).end("bad request");
        return;
      }
      asked.push({ method: request.method, path: req.url ?? "/" });
      answer(request).then(
        (result) => reply({ jsonrpc: "2.0", id: request.id ?? 1, result }),
        (error: Error) =>
          reply({
            jsonrpc: "2.0",
            id: request.id ?? 1,
            error: { code: -32000, message: error.message },
          }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    sent,
    asked,
    sponsored: () => sponsored,
    simulateCalls: (on) => {
      simulate = on;
    },
    hold: (on) => {
      holding = on;
    },
    drop: (hash) => {
      const at = sent.findIndex((s) => s.hash === hash.toLowerCase());
      if (at >= 0 && held.delete(hash.toLowerCase())) sent.splice(at, 1);
    },
    release: async () => {
      for (const hash of [...held]) {
        const entry = sent.find((s) => s.hash === hash);
        held.delete(hash);
        if (entry) await submit(entry);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
