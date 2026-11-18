import { describe, expect, it } from "vitest";
import type { MoneyCall } from "./calls";
import {
  addressFromWord,
  type Eip1193Provider,
  injectedWallet,
  WalletStepError,
} from "./wallet";

const FROM = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const calls: MoneyCall[] = [
  { to: "0x01", data: "0xaa", value: "0x0" },
  { to: "0x02", data: "0xbb", value: "0x0" },
];

function provider(answers: {
  chain?: string;
  status?: (hash: string, poll: number) => string | null;
  send?: (index: number) => unknown;
}) {
  const sent: unknown[] = [];
  const polls = new Map<string, number>();
  const p: Eip1193Provider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [FROM];
      if (method === "eth_chainId") return answers.chain ?? "0x7a69";
      if (method === "wallet_switchEthereumChain") throw { code: 4902 };
      if (method === "eth_sendTransaction") {
        const index = sent.length;
        sent.push(params?.[0]);
        const outcome = answers.send?.(index);
        if (
          outcome instanceof Error ||
          (outcome && typeof outcome === "object")
        )
          throw outcome;
        return `0xhash${index}`;
      }
      if (method === "eth_getTransactionReceipt") {
        const hash = String(params?.[0]);
        const poll = (polls.get(hash) ?? 0) + 1;
        polls.set(hash, poll);
        const status = answers.status ? answers.status(hash, poll) : "0x1";
        return status === null ? null : { status };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { p, sent };
}

describe("the injected wallet", () => {
  it("sends each call after the one before it landed, unchanged", async () => {
    const { p, sent } = provider({
      status: (_h, poll) => (poll < 2 ? null : "0x1"),
    });
    const wallet = injectedWallet(p, { pollMs: 0 });
    await expect(wallet.sendCalls(calls, 31337)).resolves.toEqual({
      txHash: "0xhash1",
      status: "confirmed",
    });
    expect(sent).toEqual([
      { from: FROM, to: "0x01", data: "0xaa", value: "0x0" },
      { from: FROM, to: "0x02", data: "0xbb", value: "0x0" },
    ]);
  });

  it("stops at a refused call and says how many landed", async () => {
    const { p, sent } = provider({
      send: (i) => (i === 1 ? { code: 4001 } : null),
    });
    const error = await injectedWallet(p, { pollMs: 0 })
      .sendCalls(calls, 31337)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletStepError);
    expect((error as WalletStepError).landed).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("does not send the second call when the first reverted", async () => {
    const { p, sent } = provider({ status: () => "0x0" });
    const error = await injectedWallet(p, { pollMs: 0 })
      .sendCalls(calls, 31337)
      .catch((e: unknown) => e);
    expect((error as WalletStepError).reason).toBe("reverted");
    expect(sent).toHaveLength(1);
  });

  it("gives up waiting after a bounded time, as not landed yet", async () => {
    const { p } = provider({ status: () => null });
    const error = await injectedWallet(p, { pollMs: 0, polls: 3 })
      .sendCalls(calls, 31337)
      .catch((e: unknown) => e);
    expect((error as WalletStepError).reason).toBe("pending");
  });

  it("refuses to send on another network it cannot switch from", async () => {
    const { p, sent } = provider({ chain: "0x1" });
    const error = await injectedWallet(p, { pollMs: 0 })
      .sendCalls(calls, 31337)
      .catch((e: unknown) => e);
    expect((error as WalletStepError).reason).toBe("wrong-network");
    expect(sent).toHaveLength(0);
  });

  it("without a wallet, says so", async () => {
    const wallet = injectedWallet(undefined);
    expect(wallet.isAvailable()).toBe(false);
    expect(await wallet.connectedAddress()).toBeNull();
    const error = await wallet.sendCalls(calls, 1).catch((e: unknown) => e);
    expect((error as WalletStepError).reason).toBe("no-wallet");
  });

  it("reads an address out of a call's answer", () => {
    expect(addressFromWord(`0x${"0".repeat(24)}${"ab".repeat(20)}`)).toBe(
      `0x${"ab".repeat(20)}`,
    );
    expect(addressFromWord("0x12")).toBeNull();
  });
});
