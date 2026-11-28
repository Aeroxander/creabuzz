import { describe, expect, it } from "vitest";
import { backCalls } from "@creaton/core/pot/pot-calls.ts";
import type { MoneyCall } from "./calls";
import type { PotNetwork } from "@creaton/core/pot/network.ts";
import { potFallback, potProblem } from "./problems";
import {
  addressFromWord,
  type Eip1193Provider,
  injectedWallet,
  readLogsBack,
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

  it("asks a call that landed and reverted again as a read, so the contract's reason reaches the person", async () => {
    const asked: unknown[] = [];
    const p: Eip1193Provider = {
      async request({ method, params }) {
        if (method === "eth_requestAccounts") return [FROM];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_getTransactionCount") return "0x0";
        if (method === "eth_sendTransaction") return "0xhash0";
        if (method === "eth_getTransactionReceipt") return { status: "0x0" };
        if (method === "eth_call") {
          asked.push(params?.[0]);
          // CapReached(uint256): the Launcher refused the round
          throw {
            code: 3,
            message: "execution reverted",
            data: "0x0d16778000000000000000000000000000000000000000000000000000000002540be400",
          };
        }
        throw new Error(method);
      },
    };
    const error = await injectedWallet(p, { pollMs: 0 })
      .sendCalls([calls[0]], 31337)
      .catch((e: unknown) => e);
    expect((error as WalletStepError).reason).toBe("reverted");
    expect(asked).toEqual([
      { from: FROM, to: "0x01", data: "0xaa", value: "0x0" },
    ]);
    expect(potProblem(error, "back")).toBe(potFallback("back"));
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

  describe("a wallet that does not know the network", () => {
    const known: PotNetwork = {
      chainId: 31337,
      name: "Local test network",
      launcher: `0x${"1".repeat(40)}`,
      dollar: null,
      rpcUrl: "http://192.168.1.20:8545",
      playMoney: true,
    };

    /** A wallet on mainnet that answers the switch with `refusal` until the network is added, and the add with `onAdd`. */
    function walletThatKnowsNothing(
      refusal: unknown,
      onAdd: "yes" | "no" | "yes-without-moving" = "yes",
    ) {
      const asked: { method: string; params?: unknown[] }[] = [];
      let chain = "0x1";
      let added = false;
      const p: Eip1193Provider = {
        async request({ method, params }) {
          asked.push({ method, params });
          if (method === "eth_requestAccounts") return [FROM];
          if (method === "eth_chainId") return chain;
          if (method === "wallet_switchEthereumChain") {
            if (!added) throw refusal;
            chain = "0x7a69";
            return null;
          }
          if (method === "wallet_addEthereumChain") {
            if (onAdd === "no") throw { code: 4001, message: "rejected" };
            added = true;
            if (onAdd === "yes") chain = "0x7a69";
            return null;
          }
          if (method === "eth_sendTransaction") return "0xhash0";
          if (method === "eth_getTransactionReceipt") return { status: "0x1" };
          throw new Error(`unexpected ${method}`);
        },
      };
      return { p, asked };
    }
    const names = (asked: { method: string }[]) => asked.map((a) => a.method);

    it("offers to add it with the network's name, node address and currency, then sends", async () => {
      const { p, asked } = walletThatKnowsNothing({ code: 4902 });
      await injectedWallet(p, { pollMs: 0 }, () => known).sendCalls(
        calls.slice(0, 1),
        31337,
      );
      const add = asked.find((a) => a.method === "wallet_addEthereumChain");
      expect(add?.params).toEqual([
        {
          chainId: "0x7a69",
          chainName: "Local test network",
          rpcUrls: ["http://192.168.1.20:8545"],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        },
      ]);
      expect(names(asked).indexOf("wallet_addEthereumChain")).toBeLessThan(
        names(asked).indexOf("eth_sendTransaction"),
      );
    });

    it("knows the unknown-network answer inside what a wallet app wraps it in", async () => {
      const wrapped = Object.assign(new Error("internal"), {
        code: -32603,
        data: { originalError: { code: 4902 } },
      });
      const { p, asked } = walletThatKnowsNothing(wrapped);
      await injectedWallet(p, { pollMs: 0 }, () => known).ensureChain(31337);
      expect(names(asked)).toContain("wallet_addEthereumChain");
    });

    it("asks the wallet to switch when adding did not move it", async () => {
      const { p, asked } = walletThatKnowsNothing(
        { code: 4902 },
        "yes-without-moving",
      );
      await injectedWallet(p, { pollMs: 0 }, () => known).ensureChain(31337);
      expect(
        names(asked).filter((m) => m === "wallet_switchEthereumChain"),
      ).toHaveLength(2);
    });

    it("sends nothing when the person says no to adding it", async () => {
      const { p, asked } = walletThatKnowsNothing({ code: 4902 }, "no");
      const error = await injectedWallet(p, { pollMs: 0 }, () => known)
        .sendCalls(calls, 31337)
        .catch((e: unknown) => e);
      expect((error as WalletStepError).reason).toBe("wrong-network");
      expect(names(asked)).not.toContain("eth_sendTransaction");
    });

    it("does not offer a network it has no address for, nor one that is not the one asked for", async () => {
      for (const net of [
        { ...known, rpcUrl: null },
        { ...known, chainId: 5 },
      ]) {
        const { p, asked } = walletThatKnowsNothing({ code: 4902 });
        const error = await injectedWallet(p, { pollMs: 0 }, () => net)
          .ensureChain(31337)
          .catch((e: unknown) => e);
        expect((error as WalletStepError).reason).toBe("wrong-network");
        expect(names(asked)).not.toContain("wallet_addEthereumChain");
      }
    });

    it("does not offer to add a network after a plain refusal to switch", async () => {
      const { p, asked } = walletThatKnowsNothing({
        code: 4001,
        message: "rejected",
      });
      const error = await injectedWallet(p, { pollMs: 0 }, () => known)
        .ensureChain(31337)
        .catch((e: unknown) => e);
      expect((error as WalletStepError).reason).toBe("wrong-network");
      expect(names(asked)).not.toContain("wallet_addEthereumChain");
    });
  });

  it("without a wallet, says so", async () => {
    const wallet = injectedWallet(undefined);
    expect(wallet.isAvailable()).toBe(false);
    expect(await wallet.connectedAddress()).toBeNull();
    const error = await wallet.sendCalls(calls, 1).catch((e: unknown) => e);
    expect((error as WalletStepError).reason).toBe("no-wallet");
  });

  it("a receipt lookup that fails after the call went out is not landed yet, never 'nothing changed' (F3)", async () => {
    const sent: unknown[] = [];
    const p: Eip1193Provider = {
      async request({ method, params }) {
        if (method === "eth_requestAccounts") return [FROM];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_sendTransaction") {
          sent.push(params?.[0]);
          return `0x${sent.length.toString(16).padStart(64, "0")}`;
        }
        // The approval landed; the wallet's node then rate-limits every receipt lookup for the ask.
        if (method === "eth_getTransactionReceipt") {
          if (params?.[0] === `0x${"1".padStart(64, "0")}`)
            return { status: "0x1" };
          throw { code: -32005, message: "request rate exceeded" };
        }
        throw new Error(method);
      },
    };
    const error = await injectedWallet(p, { polls: 2, pollMs: 0 })
      .sendCalls(
        backCalls({
          dollar: `0x${"11".repeat(20)}`,
          treasury: `0x${"22".repeat(20)}`,
          amount: 25_000_000n,
          minShares: 1n,
          to: FROM,
          payAndCall: false,
        }),
        31337,
      )
      .catch((e: unknown) => e);
    expect(sent).toHaveLength(2);
    expect((error as WalletStepError).reason).toBe("pending");
    expect((error as WalletStepError).hash).toBe(`0x${"2".padStart(64, "0")}`);
    expect(potProblem(error, "back")).not.toMatch(
      /Nothing changed|Nothing was taken/,
    );
  });

  it("a lookup that fails once is one more poll, and the call then lands", async () => {
    let lookups = 0;
    const p: Eip1193Provider = {
      async request({ method }) {
        if (method === "eth_requestAccounts") return [FROM];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_sendTransaction") return "0xabc";
        if (method === "eth_getTransactionReceipt") {
          lookups += 1;
          if (lookups === 1) throw new Error("connection dropped");
          return { status: "0x1" };
        }
        throw new Error(method);
      },
    };
    await expect(
      injectedWallet(p, { pollMs: 0 }).sendCalls([calls[0]], 31337),
    ).resolves.toEqual({ txHash: "0xabc", status: "confirmed" });
  });

  it("says what became of a call sent earlier", async () => {
    const answers: Record<string, { receipt: unknown; tx: unknown }> = {
      "0x1": { receipt: { status: "0x1" }, tx: {} },
      "0x2": { receipt: { status: "0x0" }, tx: {} },
      "0x3": { receipt: null, tx: { hash: "0x3" } },
      "0x4": { receipt: null, tx: null },
    };
    // FROM has used nonces 0 to 4 on chain ("latest" 5); one more call waits ("pending" 6).
    const counts: Record<string, string> = { latest: "0x5", pending: "0x6" };
    const p: Eip1193Provider = {
      async request({ method, params }) {
        if (method === "eth_getTransactionCount") {
          expect(params?.[0]).toBe(FROM);
          return counts[String(params?.[1])];
        }
        const a = answers[String(params?.[0])];
        if (method === "eth_getTransactionReceipt") return a.receipt;
        if (method === "eth_getTransactionByHash") return a.tx;
        throw new Error(method);
      },
    };
    const wallet = injectedWallet(p);
    const at = (hash: string, nonce: number | null) =>
      wallet.outcomeOf({ hash, from: FROM, nonce });
    expect(await at("0x1", 3)).toBe("landed");
    expect(await at("0x2", 3)).toBe("reverted");
    expect(await at("0x3", 9)).toBe("waiting");
    // Gone under its hash: never seen, nothing in its place.
    expect(await at("0x4", 6)).toBe("unknown");
    // Gone under its hash, its nonce mined: sped up or cancelled in the wallet.
    expect(await at("0x4", 4)).toBe("replaced");
    // Gone under its hash, another call with its nonce waits.
    expect(await at("0x4", 5)).toBe("waiting");
    // Its nonce not known: a gone hash is never taken as never sent.
    expect(await at("0x4", null)).toBe("replaced");
  });

  it("keeps the account and nonce of a call that has not landed", async () => {
    const { p } = provider({ status: (h) => (h === "0xhash1" ? null : "0x1") });
    const nonces = new Map([["0xhash1", "0x2a"]]);
    const withNonces: Eip1193Provider = {
      async request(args) {
        if (args.method === "eth_getTransactionByHash")
          return { nonce: nonces.get(String(args.params?.[0])) };
        if (args.method === "eth_getTransactionCount") return "0x29";
        return p.request(args);
      },
    };
    const error = await injectedWallet(withNonces, { polls: 2, pollMs: 0 })
      .sendCalls(calls, 31337)
      .catch((e) => e);
    expect((error as WalletStepError).reason).toBe("pending");
    expect((error as WalletStepError).sent).toEqual({ from: FROM, nonce: 42 });
  });

  it("falls back to the account's next nonce before sending when the network does not give the call's own", async () => {
    const { p } = provider({ status: () => null });
    const counting: Eip1193Provider = {
      async request(args) {
        if (args.method === "eth_getTransactionByHash") return null;
        if (args.method === "eth_getTransactionCount") return "0x7";
        return p.request(args);
      },
    };
    const error = await injectedWallet(counting, { polls: 1, pollMs: 0 })
      .sendCalls(calls, 31337)
      .catch((e) => e);
    expect((error as WalletStepError).sent).toEqual({ from: FROM, nonce: 7 });
  });

  it("reads an address out of a call's answer", () => {
    expect(addressFromWord(`0x${"0".repeat(24)}${"ab".repeat(20)}`)).toBe(
      `0x${"ab".repeat(20)}`,
    );
    expect(addressFromWord("0x12")).toBeNull();
  });
});

describe("reading the chain's logs", () => {
  const LOG = {
    address: "0x0a",
    topics: ["0x01"],
    data: "0x",
    blockNumber: "0x10",
  };

  it("asks for the block number and the logs of one address in hex blocks", async () => {
    const asked: unknown[] = [];
    const wallet = injectedWallet({
      async request({ method, params }) {
        if (method === "eth_blockNumber") return "0x2a";
        if (method === "eth_getLogs") {
          asked.push(params?.[0]);
          return [LOG, { junk: true }];
        }
        throw new Error(method);
      },
    });
    expect(await wallet.blockNumber()).toBe(42);
    expect(
      await wallet.getLogs({
        address: "0x0a",
        topics: ["0x01", null],
        from: 16,
        to: 42,
      }),
    ).toEqual([LOG]);
    expect(asked).toEqual([
      {
        address: "0x0a",
        topics: ["0x01", null],
        fromBlock: "0x10",
        toBlock: "0x2a",
      },
    ]);
  });

  it("reads a long window in bounded pieces, newest first, and says when it stopped early", async () => {
    const ranges: [number, number][] = [];
    const getLogs = async (f: { from: number; to: number }) => {
      ranges.push([f.from, f.to]);
      return [{ ...LOG, blockNumber: `0x${f.to.toString(16)}` }];
    };
    const all = await readLogsBack(
      { getLogs },
      { address: "0x0a", topics: [] },
      { from: 0, to: 24_999, chunk: 10_000, pieces: 5 },
    );
    expect(ranges).toEqual([
      [15_000, 24_999],
      [5_000, 14_999],
      [0, 4_999],
    ]);
    expect(all.complete).toBe(true);
    expect(all.logs.map((l) => Number.parseInt(l.blockNumber, 16))).toEqual([
      4_999, 14_999, 24_999,
    ]);
    ranges.length = 0;
    const cut = await readLogsBack(
      { getLogs },
      { address: "0x0a", topics: [] },
      { from: 0, to: 99_999, chunk: 10_000, pieces: 2 },
    );
    expect(ranges.length).toBe(2);
    expect(cut.complete).toBe(false);
  });
});
