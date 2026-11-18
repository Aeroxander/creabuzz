import type { Page } from "@playwright/test";
import { selectorOf } from "../../../../packages/creaton-core/src/launchpad/evmAbi.ts";

/** A 32-byte word for a stub's answer. */
export const word = (n: bigint | number) =>
  BigInt(n).toString(16).padStart(64, "0");
export const addressWord = (a: string) =>
  a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/**
 * A wallet in the page (`window.ethereum`) for Team and market journeys: it answers reads by function (each answer a
 * fixed hex string), lists the given logs, signs typed data with a fixed fake, and records every transaction it is
 * asked to send (`sentCalls` in `money-world.ts` reads them). Every send lands at once.
 */
export async function installChainWallet(
  page: Page,
  options: {
    account: string;
    /** Answers by function signature, e.g. { "first()": "0x…" }. Anything else reads as zero. */
    reads?: Record<string, string>;
    /** Answers by the call's exact data (checked before `reads`), for a read whose answer depends on its arguments. */
    exact?: Record<string, string>;
    logs?: unknown[];
    block?: number;
  },
) {
  const reads: Record<string, string> = {};
  for (const [signature, answer] of Object.entries(options.reads ?? {}))
    reads[selectorOf(signature)] = answer;
  for (const [data, answer] of Object.entries(options.exact ?? {}))
    reads[data.toLowerCase()] = answer;
  await page.addInitScript(
    ([account, readsIn, logs, block]) => {
      const w = window as unknown as {
        ethereum: unknown;
        __sent: unknown[];
      };
      w.__sent = [];
      w.ethereum = {
        async request({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) {
          if (method === "eth_accounts" || method === "eth_requestAccounts")
            return [account];
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_blockNumber") return `0x${block.toString(16)}`;
          if (method === "eth_getLogs") return logs;
          if (method === "eth_getTransactionCount")
            return `0x${w.__sent.length.toString(16)}`;
          if (method === "eth_getTransactionByHash") return null;
          if (method === "eth_signTypedData_v4") return `0x${"11".repeat(65)}`;
          if (method === "eth_call") {
            const data = String(
              (params?.[0] as { data: string }).data,
            ).toLowerCase();
            const table = readsIn as Record<string, string>;
            return (
              table[data] ?? table[data.slice(0, 10)] ?? `0x${"0".repeat(64)}`
            );
          }
          if (method === "eth_getTransactionReceipt") return { status: "0x1" };
          if (method === "eth_sendTransaction") {
            w.__sent.push(params?.[0]);
            return `0x${w.__sent.length.toString(16).padStart(64, "0")}`;
          }
          throw { code: 4200, message: `unsupported ${method}` };
        },
      };
    },
    [
      options.account,
      reads,
      options.logs ?? [],
      options.block ?? 5_000,
    ] as const,
  );
}
