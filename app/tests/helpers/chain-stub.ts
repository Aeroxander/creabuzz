/**
 * A wallet in the page for Team and market screen tests: it answers reads per function (by selector, with the call's
 * data so an answer may depend on its arguments), lists logs, and records every call it is asked to send. Sends land at
 * once unless `refuse` names a revert to throw.
 */
import { selectorOf } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";

export const word = (n: bigint | number | string) =>
  typeof n === "string"
    ? n.replace(/^0x/, "").padStart(64, "0")
    : BigInt(n).toString(16).padStart(64, "0");
export const addressWord = (a: string) => word(a.toLowerCase());

export interface StubCall {
  from: string;
  to: string;
  data: string;
}

export interface ChainStub {
  sent: StubCall[];
  signed: unknown[];
  /** The account the wallet uses now. */
  account: string;
  /** The next send fails with this revert data, once. */
  refuse: string | null;
  /** While true no sent call has a receipt yet (the wallet's wait runs out); set false and they have landed. */
  holdReceipts: boolean;
}

export function installChainStub(options: {
  account: string;
  /** Answers by function signature ("first()") or selector; a function gets the call's `to` and data. */
  reads?: Record<string, string | ((to: string, data: string) => string)>;
  logs?: () => unknown[];
  block?: number;
  /** The wallet's signature for typed data; default a fixed fake. */
  sign?: (from: string, typed: string) => string;
}): ChainStub {
  const stub: ChainStub = {
    sent: [],
    signed: [],
    account: options.account,
    refuse: null,
    holdReceipts: false,
  };
  const bySelector = new Map<
    string,
    string | ((to: string, data: string) => string)
  >();
  for (const [key, answer] of Object.entries(options.reads ?? {}))
    bySelector.set(
      key.startsWith("0x") ? key.toLowerCase() : selectorOf(key),
      answer,
    );
  (window as unknown as { ethereum: unknown }).ethereum = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts")
        return [stub.account];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_blockNumber")
        return `0x${(options.block ?? 1000).toString(16)}`;
      if (method === "eth_getLogs") return options.logs?.() ?? [];
      if (method === "eth_getTransactionCount")
        return `0x${stub.sent.length.toString(16)}`;
      if (method === "eth_getTransactionByHash") return null;
      if (method === "eth_signTypedData_v4") {
        const [from, typed] = params as [string, string];
        stub.signed.push(JSON.parse(typed));
        return options.sign?.(from, typed) ?? `0x${"11".repeat(65)}`;
      }
      if (method === "eth_call") {
        const { to, data } = params?.[0] as { to: string; data: string };
        const answer = bySelector.get(data.slice(0, 10).toLowerCase());
        if (answer === undefined) return `0x${word(0)}`;
        return typeof answer === "function" ? answer(to, data) : answer;
      }
      if (method === "eth_sendTransaction") {
        if (stub.refuse) {
          const data = stub.refuse;
          stub.refuse = null;
          throw { code: -32603, message: "execution reverted", data: { data } };
        }
        const tx = params?.[0] as { to: string; data: string };
        stub.sent.push({ from: stub.account, to: tx.to, data: tx.data });
        return `0x${stub.sent.length.toString(16).padStart(64, "0")}`;
      }
      if (method === "eth_getTransactionReceipt")
        return stub.holdReceipts ? null : { status: "0x1" };
      throw { code: 4200, message: method };
    },
  };
  return stub;
}
