/**
 * The person's wallet in this browser (an injected EIP-1193 provider, `window.ethereum`), behind the small sender shape
 * web/'s launchpad flows use (`getAddress`, `sendCalls`, `isAvailable`), plus a read and a no-prompt address lookup.
 *
 * Calls are sent one at a time, and each one must land before the next is sent: the round can only take dollars the
 * approval before it allowed. Waiting is bounded; a call that has not landed in time is reported as such, never as done
 * and never as failed.
 *
 * The phone path (a passkey account with sponsored fees) is the other sender, in `passkey-sender.ts`; `sender.ts` picks.
 */
import { walletError } from "@creaton/core/launchpad/wallet-errors.ts";
import type { MoneyCall } from "./calls";

/** A log as the network returns it (`eth_getLogs`). */
export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * A call that went out: its hash, the account that sent it, and its nonce (its place in that account's order of calls),
 * or null when the network did not say. A wallet that speeds a call up or cancels it sends another call with the same
 * nonce under a new hash, so the nonce is what tells "replaced" from "never seen".
 */
export interface SentCall {
  hash: string;
  from: string;
  nonce: number | null;
}

/** The two ways a step can be sent: the wallet in this browser, or the person's own passkey account (`sender.ts`). */
export type SenderKind = "wallet" | "passkey";

/**
 * Whether a sender can send now, and when it cannot, why: nothing injected in this browser (`no-wallet`), the server
 * has not switched passkey sending on (`not-set-up`), or this browser holds no passkey that can own an account
 * (`no-passkey`).
 */
export type SenderAvailability =
  | { ok: true }
  | { ok: false; reason: "no-wallet" | "not-set-up" | "no-passkey" };

/** What a send is doing now, for a sender that has more than one stage to show. */
export type SendPhase =
  | "preparing"
  | "checking"
  | "signing"
  | "sending"
  | "confirming";

export interface SendOptions {
  onPhase?: (phase: SendPhase) => void;
}

/** What a sender can and cannot do, so a screen asks before it offers a press. */
export interface SenderCapabilities {
  /** Can sign a message (typed data) for the account. */
  signsMessages: boolean;
  /** Sends all calls of a step as one all-or-nothing operation. */
  atomicBatch: boolean;
  /** The network fee is paid by the server, not the account. */
  feeSponsored: boolean;
}

/** Why a wallet step stopped. `landed` counts the calls of the batch that did land before it. */
export class WalletStepError extends Error {
  constructor(
    readonly reason:
      | "no-wallet"
      | "not-set-up"
      | "no-passkey"
      | "not-known"
      | "wrong-network"
      | "reverted"
      | "pending"
      | "replaced"
      | "failed",
    readonly landed: number,
    readonly cause?: unknown,
    /** The hash of the call that was sent but whose outcome is not known yet ("pending" only). */
    readonly hash?: string,
    /** Who sent that call and its nonce ("pending" from `sendCalls` only). */
    readonly sent?: Omit<SentCall, "hash">,
  ) {
    super(reason);
    this.name = "WalletStepError";
  }
}

/**
 * What sends a person's money steps: the injected wallet or the passkey account (`sender.ts` picks). The three members
 * marked optional are always given by the two real senders and may be left out by a stand-in in a test; read them with
 * `senderKind`, `senderAvailability` and `senderCapabilities`.
 */
export interface MoneyWallet {
  readonly kind?: SenderKind;
  availability?(): SenderAvailability;
  readonly capabilities?: SenderCapabilities;
  isAvailable(): boolean;
  /** The account the wallet already shares with this site, without asking; null when it shares none. */
  connectedAddress(): Promise<string | null>;
  /** The account to send from; the wallet may ask the person to connect. */
  getAddress(): Promise<string>;
  /** Send `calls` in order on chain `chainId`, each landing before the next. */
  sendCalls(
    calls: readonly MoneyCall[],
    chainId: number,
    options?: SendOptions,
  ): Promise<{ txHash: string; status: "confirmed"; userOpHash?: string }>;
  /** A read-only call's raw answer. */
  readCall(to: string, data: string): Promise<string>;
  /** The network's newest block number. */
  blockNumber(): Promise<number>;
  /** The network the wallet is on now. */
  chainId(): Promise<number>;
  /** Ask the wallet to sign typed data (EIP-712) as `from`; its signature. Never a transfer. */
  signTypedData(from: string, typedData: unknown): Promise<string>;
  /** Logs of `address` with `topics`, from block `from` to `to` (both included). Callers keep the range small. */
  getLogs(filter: {
    address: string;
    topics: (string | null)[];
    from: number;
    to: number;
  }): Promise<ChainLog[]>;
  /** Make sure the wallet is on chain `chainId`, asking it to switch when it is not. */
  ensureChain(chainId: number): Promise<void>;
  /**
   * What became of a call sent earlier: landed, reverted, still waiting (it, or another call in its place), replaced
   * (its hash is gone but its nonce was used: the wallet sped it up or cancelled it, so it may have landed under another
   * hash; also said when its nonce is not known), or unknown to the network (dropped, never mined, nothing in its
   * place). Call `ensureChain` first: on another network every hash is unknown.
   */
  outcomeOf(
    sent: SentCall,
  ): Promise<"landed" | "reverted" | "waiting" | "replaced" | "unknown">;
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

  /** A hex quantity as a number, or null. */
  const quantity = (value: unknown): number | null => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,13}$/.test(value))
      return null;
    return Number.parseInt(value, 16);
  };

  /** How many calls `from` has sent, as of `tag`; throws when the network does not say. */
  async function callCount(from: string, tag: "latest" | "pending") {
    const count = quantity(await ask("eth_getTransactionCount", [from, tag]));
    if (count === null) throw new Error("The network did not give a count.");
    return count;
  }

  /** Best effort: a lookup that fails gives null, never a failed step. */
  async function maybe<T>(lookup: () => Promise<T>): Promise<T | null> {
    try {
      return await lookup();
    } catch {
      return null;
    }
  }

  /** A sent call's nonce, from the network's copy of it, or null. */
  async function nonceOf(hash: string): Promise<number | null> {
    const tx = await maybe(() => ask("eth_getTransactionByHash", [hash]));
    return tx && typeof tx === "object"
      ? quantity((tx as { nonce?: unknown }).nonce)
      : null;
  }

  /** The receipt's status ("0x1" landed, anything else reverted), or null while there is none. */
  async function receiptStatus(hash: string): Promise<string | null> {
    const receipt = (await ask("eth_getTransactionReceipt", [hash])) as {
      status?: string;
    } | null;
    return receipt && typeof receipt.status === "string"
      ? receipt.status
      : null;
  }

  /**
   * Wait, bounded, for a sent call to land. A lookup that fails (a rate limit, a dropped connection, a wallet browser
   * sent to the background) is one more poll, never a failure: the call was sent, so its outcome is unknown, not "no".
   */
  /**
   * Why a call that landed reverted: the same call asked again as a read, whose refusal carries the contract's reason (a
   * wallet that sent without asking first, or a state that changed in between, gives only "reverted"). Best effort.
   */
  async function whyReverted(tx: {
    from: string;
    to: string;
    data: string;
  }): Promise<unknown> {
    try {
      await need().request({
        method: "eth_call",
        params: [{ ...tx, value: "0x0" }, "latest"],
      });
      return undefined;
    } catch (error) {
      return error;
    }
  }

  async function landed(
    hash: string,
    index: number,
    tx: { from: string; to: string; data: string },
  ) {
    for (let poll = 0; poll < polls; poll += 1) {
      let status: string | null = null;
      try {
        status = await receiptStatus(hash);
      } catch {
        status = null;
      }
      if (status !== null) {
        if (status === "0x1") return;
        throw new WalletStepError(
          "reverted",
          index,
          await whyReverted(tx),
          hash,
        );
      }
      await sleep(pollMs);
    }
    throw new WalletStepError("pending", index, undefined, hash);
  }

  return {
    kind: "wallet",
    availability: () =>
      provider !== undefined
        ? { ok: true }
        : { ok: false, reason: "no-wallet" },
    capabilities: {
      signsMessages: true,
      atomicBatch: false,
      feeSponsored: false,
    },
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
        // The account's next nonce before sending: the call takes it or a later one, so it is never too high to say
        // "replaced" (the safe answer) when the network gives the call's own nonce no more.
        const before = await maybe(() => callCount(from, "pending"));
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
        try {
          await landed(hash, index, { from, to: call.to, data: call.data });
        } catch (error) {
          // Once a hash exists the call is out: anything but a known revert is "not landed yet", never "nothing sent".
          if (error instanceof WalletStepError && error.reason === "reverted")
            throw error;
          const nonce = (await nonceOf(hash)) ?? before;
          throw new WalletStepError(
            "pending",
            index,
            error instanceof WalletStepError ? error.cause : error,
            hash,
            { from, nonce },
          );
        }
        last = hash;
      }
      return { txHash: last, status: "confirmed" };
    },
    async readCall(to, data) {
      const answer = await ask("eth_call", [{ to, data }, "latest"]);
      if (typeof answer !== "string") throw new Error("No answer.");
      return answer;
    },
    async blockNumber() {
      const block = quantity(await ask("eth_blockNumber"));
      if (block === null) throw new Error("The network did not give a block.");
      return block;
    },
    async chainId() {
      const chain = quantity(await ask("eth_chainId"));
      if (chain === null)
        throw new Error("The wallet did not say its network.");
      return chain;
    },
    async signTypedData(from, typedData) {
      const signature = await ask("eth_signTypedData_v4", [
        from,
        JSON.stringify(typedData),
      ]);
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature))
        throw new Error("The wallet gave no signature.");
      return signature;
    },
    async getLogs(filter) {
      const logs = await ask("eth_getLogs", [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: `0x${filter.from.toString(16)}`,
          toBlock: `0x${filter.to.toString(16)}`,
        },
      ]);
      if (!Array.isArray(logs)) throw new Error("The network gave no logs.");
      return logs.filter(isLog);
    },
    ensureChain: onChain,
    async outcomeOf(sent) {
      const status = await receiptStatus(sent.hash);
      if (status !== null) return status === "0x1" ? "landed" : "reverted";
      const known = await ask("eth_getTransactionByHash", [sent.hash]);
      if (known) return "waiting";
      // Gone under this hash. Its nonce says whether another call took its place (sped up or cancelled in the wallet).
      if (sent.nonce === null) return "replaced";
      if ((await callCount(sent.from, "latest")) > sent.nonce)
        return "replaced";
      if ((await callCount(sent.from, "pending")) > sent.nonce)
        return "waiting";
      return "unknown";
    },
  };
}

/** Which kind of sender this is (a stand-in without one is a wallet). */
export function senderKind(sender: MoneyWallet): SenderKind {
  return sender.kind ?? "wallet";
}

/** Whether `sender` can send now, and why not. */
export function senderAvailability(sender: MoneyWallet): SenderAvailability {
  return (
    sender.availability?.() ??
    (sender.isAvailable() ? { ok: true } : { ok: false, reason: "no-wallet" })
  );
}

/** What `sender` can do (a stand-in without a list is a plain wallet). */
export function senderCapabilities(sender: MoneyWallet): SenderCapabilities {
  return (
    sender.capabilities ?? {
      signsMessages: true,
      atomicBatch: false,
      feeSponsored: false,
    }
  );
}

function isLog(value: unknown): value is ChainLog {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.address === "string" &&
    typeof v.data === "string" &&
    typeof v.blockNumber === "string" &&
    Array.isArray(v.topics) &&
    v.topics.every((t) => typeof t === "string")
  );
}

/**
 * Logs over a window that may be wider than a wallet's node allows in one ask: read in pieces of `chunk` blocks, newest
 * piece first, at most `pieces` of them (bounded; what lies before is not read and the caller is told so).
 */
export async function readLogsBack(
  wallet: Pick<MoneyWallet, "getLogs">,
  filter: { address: string; topics: (string | null)[] },
  window: { from: number; to: number; chunk?: number; pieces?: number },
): Promise<{ logs: ChainLog[]; complete: boolean }> {
  const chunk = window.chunk ?? 10_000;
  const pieces = window.pieces ?? 5;
  const logs: ChainLog[] = [];
  let to = window.to;
  for (let piece = 0; piece < pieces; piece += 1) {
    if (to < window.from) return { logs, complete: true };
    const from = Math.max(window.from, to - chunk + 1);
    logs.unshift(...(await wallet.getLogs({ ...filter, from, to })));
    to = from - 1;
  }
  return { logs, complete: to < window.from };
}

/** An address from a 32-byte call answer, or null. */
export function addressFromWord(word: string): string | null {
  const hex = word.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex.slice(24).toLowerCase()}`;
}
