/**
 * A stand-in for the hosted bundler and paymaster (ZeroDev) on a local fork of Sepolia, for journeys where people act
 * from passkey accounts (D139). The app's own code builds, hashes and signs each user operation exactly as on the hosted
 * stack; this answers the three calls it makes there:
 *
 * - `zd_sponsorUserOperation`: the calls are first run against the fork as the entry point would run them (for an
 *   account that exists), and a call that would fail is refused here, before any passkey prompt, as the hosted service
 *   refuses it; then fixed gas limits and the fork's `AcceptAllPaymaster` (contracts/test/helpers), which pays for
 *   everything from its deposit at the entry point;
 * - `eth_sendUserOperation`: the operation sent to the real EntryPoint v0.7 on the fork in a `handleOps` transaction from
 *   an unlocked account, as a bundler would, and refused when that transaction fails; the hash returned is the entry
 *   point's own `getUserOpHash`. Every operation is recorded here, when it is sent;
 * - `eth_getUserOperationReceipt`: read back from that transaction's `UserOperationEvent`, including whether the calls
 *   inside succeeded.
 *
 * The Kernel 0.3.3 factory, its passkey validator and the P-256 verifier are Sepolia's own, read by the fork, so a
 * passkey signature made by the browser's virtual authenticator is checked by the real contracts.
 */
import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";

export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const OP = "(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)";

interface RpcUserOperation {
  sender: string;
  nonce: string;
  factory?: string;
  factoryData?: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
}

const word16 = (value: string | undefined) =>
  BigInt(value ?? "0x0")
    .toString(16)
    .padStart(32, "0");
const body = (hex: string | undefined) => (hex ?? "0x").replace(/^0x/, "");

/** The packed operation as `cast` takes a tuple. */
function packed(op: RpcUserOperation): string {
  const initCode = op.factory
    ? `0x${body(op.factory)}${body(op.factoryData)}`
    : "0x";
  const paymasterAndData = op.paymaster
    ? `0x${body(op.paymaster)}${word16(op.paymasterVerificationGasLimit)}${word16(op.paymasterPostOpGasLimit)}${body(op.paymasterData)}`
    : "0x";
  return `(${op.sender},${BigInt(op.nonce)},${initCode},${op.callData},0x${word16(op.verificationGasLimit)}${word16(op.callGasLimit)},${BigInt(op.preVerificationGas)},0x${word16(op.maxPriorityFeePerGas)}${word16(op.maxFeePerGas)},${paymasterAndData},${op.signature})`;
}

function cast(args: string[]): string {
  return execFileSync("cast", args, { encoding: "utf8" }).trim();
}

export interface StandInBundler {
  /**
   * Every operation sent, in order: its hash, the account that sent it, the paymaster that paid, and whether the calls
   * inside succeeded (null until its receipt was read).
   */
  sent: {
    hash: string;
    sender: string;
    paymaster: string;
    success: boolean | null;
  }[];
}

/**
 * Answer the page's ZeroDev calls against the fork at `rpcUrl`. `submitter` is an unlocked account with ETH that sends
 * each `handleOps`; `paymaster` is the fork's `AcceptAllPaymaster`. One bundler can serve several pages.
 */
export async function installStandInBundler(
  page: Page,
  options: { rpcUrl: string; paymaster: string; submitter: string },
  bundler: StandInBundler = { sent: [] },
): Promise<StandInBundler> {
  const event = cast([
    "keccak",
    "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
  ]);
  const txOf = new Map<string, string>();
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result?: unknown }).result;
  };
  await page.route(/rpc\.zerodev\.app/, async (route) => {
    const request = JSON.parse(route.request().postData() ?? "{}") as {
      id?: number;
      method: string;
      params: unknown[];
    };
    const answer = (result: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id ?? 1, result }),
      });
    const refuse = (message: string) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          error: { code: -32000, message },
        }),
      });
    try {
      switch (request.method) {
        case "eth_chainId":
          return answer(await rpc("eth_chainId", []));
        case "zd_sponsorUserOperation": {
          const op = request.params[0] as {
            userOp: RpcUserOperation;
          };
          const sender = op.userOp.sender;
          const code = String(await rpc("eth_getCode", [sender, "latest"]));
          if (code.length > 2) {
            // Run the calls as the entry point would, so one that would fail is refused now, as the hosted service does.
            const simulated = await fetch(options.rpcUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_call",
                params: [
                  {
                    from: ENTRY_POINT_V07,
                    to: sender,
                    data: op.userOp.callData,
                  },
                  "latest",
                ],
              }),
            });
            const outcome = (await simulated.json()) as { error?: unknown };
            if (outcome.error) {
              return refuse(
                `UserOperation reverted during simulation: ${JSON.stringify(outcome.error)}`,
              );
            }
          }
          return answer({
            preVerificationGas: "0x30d40",
            verificationGasLimit: "0x2dc6c0",
            callGasLimit: "0x989680",
            paymaster: options.paymaster,
            paymasterVerificationGasLimit: "0x186a0",
            paymasterPostOpGasLimit: "0x0",
            paymasterData: "0x",
          });
        }
        case "eth_sendUserOperation": {
          const op = request.params[0] as RpcUserOperation;
          const tuple = packed(op);
          const hash = cast([
            "call",
            ENTRY_POINT_V07,
            `getUserOpHash(${OP})(bytes32)`,
            tuple,
            "--rpc-url",
            options.rpcUrl,
          ]);
          const sent = JSON.parse(
            cast([
              "send",
              ENTRY_POINT_V07,
              `handleOps(${OP}[],address)`,
              `[${tuple}]`,
              options.submitter,
              "--from",
              options.submitter,
              "--unlocked",
              "--gas-limit",
              "30000000",
              "--rpc-url",
              options.rpcUrl,
              "--json",
            ]),
          ) as { transactionHash: string; status: string };
          if (sent.status !== "0x1" && sent.status !== "1") {
            return refuse(`handleOps failed in ${sent.transactionHash}`);
          }
          txOf.set(hash.toLowerCase(), sent.transactionHash);
          bundler.sent.push({
            hash: hash.toLowerCase(),
            sender: op.sender.toLowerCase(),
            paymaster: (op.paymaster ?? "").toLowerCase(),
            success: null,
          });
          return answer(hash);
        }
        case "eth_getUserOperationReceipt": {
          const hash = String(request.params[0]).toLowerCase();
          const tx = txOf.get(hash);
          if (!tx) return answer(null);
          const receipt = (await rpc("eth_getTransactionReceipt", [tx])) as {
            transactionHash: string;
            blockNumber: string;
            blockHash: string;
            status: string;
            gasUsed: string;
            logs: { topics: string[]; data: string }[];
          } | null;
          if (!receipt) return answer(null);
          const log = receipt.logs.find(
            (l) => l.topics[0] === event && l.topics[1]?.toLowerCase() === hash,
          );
          if (!log) return refuse(`no UserOperationEvent for ${hash}`);
          const words = log.data.slice(2).match(/.{64}/g) ?? [];
          const success = BigInt(`0x${words[1] ?? "0"}`) !== 0n;
          const sender = `0x${(log.topics[2] ?? "").slice(-40)}`;
          const recorded = bundler.sent.find((s) => s.hash === hash);
          if (recorded) recorded.success = success;
          return answer({
            userOpHash: hash,
            sender,
            nonce: `0x${BigInt(`0x${words[0] ?? "0"}`).toString(16)}`,
            actualGasCost: `0x${BigInt(`0x${words[2] ?? "0"}`).toString(16)}`,
            actualGasUsed: `0x${BigInt(`0x${words[3] ?? "0"}`).toString(16)}`,
            paymaster: `0x${(log.topics[3] ?? "").slice(-40)}`,
            success,
            logs: [],
            receipt,
          });
        }
        default:
          return refuse(
            `the stand-in bundler does not serve ${request.method}`,
          );
      }
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  });
  return bundler;
}
