/**
 * The person's wallet in this browser (an injected EIP-1193 provider, `window.ethereum`), behind the small sender shape
 * web/'s launchpad flows use (`getAddress`, `sendCalls`, `isAvailable`), plus a read and a no-prompt address lookup.
 *
 * Calls are sent one at a time, and each one must land before the next is sent: the round can only take dollars the
 * approval before it allowed. Waiting is bounded; a call that has not landed in time is reported as such, never as done
 * and never as failed.
 *
 * The phone path (a passkey account with sponsored gas, web/'s Kernel sender) is not in this app yet: the report lists it.
 */
import { walletError } from "@creaton/core/launchpad/wallet-errors.ts";
import type { MoneyCall } from "./calls";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Why a wallet step stopped. `landed` counts the calls of the batch that did land before it. */
export class WalletStepError extends Error {
  constructor(
    readonly reason:
      | "no-wallet"
      | "wrong-network"
      | "reverted"
      | "pending"
      | "failed",
    readonly landed: number,
    readonly cause?: unknown,
  ) {
    super(reason);
    this.name = "WalletStepError";
  }
}

export interface MoneyWallet {
  isAvailable(): boolean;
  /** The account the wallet already shares with this site, without asking; null when it shares none. */
  connectedAddress(): Promise<string | null>;
  /** The account to send from; the wallet may ask the person to connect. */
  getAddress(): Promise<string>;
  /** Send `calls` in order on chain `chainId`, each landing before the next. */
  sendCalls(
    calls: readonly MoneyCall[],
    chainId: number,
  ): Promise<{ txHash: string; status: "confirmed" }>;
  /** A read-only call's raw answer. */
  readCall(to: string, data: string): Promise<string>;
}

/** How long a call may take to land: about two minutes, polled every 1.5 seconds. */
const RECEIPT_POLLS = 80;
const RECEIPT_POLL_MS = 1_500;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function browserProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  const injected = (window as { ethereum?: unknown }).ethereum;
  return injected && typeof (injected as Eip1193Provider).request === "function"
    ? (injected as Eip1193Provider)
    : undefined;
}

export function injectedWallet(
  provider: Eip1193Provider | undefined = browserProvider(),
  timing: { polls?: number; pollMs?: number } = {},
): MoneyWallet {
  const polls = timing.polls ?? RECEIPT_POLLS;
  const pollMs = timing.pollMs ?? RECEIPT_POLL_MS;

  const need = (): Eip1193Provider => {
    if (!provider) throw new WalletStepError("no-wallet", 0);
    return provider;
  };

  const ask = async (method: string, params?: unknown[]) => {
    try {
      return await need().request({ method, params });
    } catch (error) {
      if (error instanceof WalletStepError) throw error;
      throw walletError(error);
    }
  };

  const firstAccount = (accounts: unknown): string | null =>
    Array.isArray(accounts) && typeof accounts[0] === "string"
      ? accounts[0].toLowerCase()
      : null;

  async function onChain(chainId: number) {
    const now = await ask("eth_chainId");
    if (typeof now === "string" && Number.parseInt(now, 16) === chainId) return;
    try {
      await ask("wallet_switchEthereumChain", [
        { chainId: `0x${chainId.toString(16)}` },
      ]);
    } catch (error) {
      throw new WalletStepError("wrong-network", 0, error);
    }
  }

  async function landed(hash: string, index: number) {
    for (let poll = 0; poll < polls; poll += 1) {
      const receipt = (await ask("eth_getTransactionReceipt", [hash])) as {
        status?: string;
      } | null;
      if (receipt && typeof receipt.status === "string") {
        if (receipt.status === "0x1") return;
        throw new WalletStepError("reverted", index);
      }
      await sleep(pollMs);
    }
    throw new WalletStepError("pending", index);
  }

  return {
    isAvailable: () => provider !== undefined,
    async connectedAddress() {
      if (!provider) return null;
      try {
        return firstAccount(await provider.request({ method: "eth_accounts" }));
      } catch {
        return null;
      }
    },
    async getAddress() {
      const address = firstAccount(await ask("eth_requestAccounts"));
      if (!address) throw new Error("No account was chosen in the wallet.");
      return address;
    },
    async sendCalls(calls, chainId) {
      if (calls.length === 0) throw new WalletStepError("failed", 0);
      const from = await this.getAddress();
      await onChain(chainId);
      let last = "";
      for (const [index, call] of calls.entries()) {
        let hash: unknown;
        try {
          // The provider's own error is kept whole: a refusal by the contract carries its reason in it.
          hash = await need().request({
            method: "eth_sendTransaction",
            params: [{ from, to: call.to, value: call.value, data: call.data }],
          });
        } catch (error) {
          throw new WalletStepError("failed", index, error);
        }
        if (typeof hash !== "string")
          throw new WalletStepError("failed", index);
        await landed(hash, index);
        last = hash;
      }
      return { txHash: last, status: "confirmed" };
    },
    async readCall(to, data) {
      const answer = await ask("eth_call", [{ to, data }, "latest"]);
      if (typeof answer !== "string") throw new Error("No answer.");
      return answer;
    },
  };
}

/** An address from a 32-byte call answer, or null. */
export function addressFromWord(word: string): string | null {
  const hex = word.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex.slice(24).toLowerCase()}`;
}
