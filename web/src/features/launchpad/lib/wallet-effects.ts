/**
 * The auction/graduation chain effects, bound to an injected wallet
 * (`window.ethereum`, EIP-1193) instead of the desktop app's `evm_*` IPC.
 *
 * Why this is its own adapter and not the {@link CallSender} the mint and bid
 * flows use: the auction deploy needs three things a plain call sender cannot
 * give it —
 * - **contract creation** (`to` omitted): the GraduationExecutor and the bid
 *   gate are deployed with `CREATE`, and the auction address is predicted from
 *   the deployer's transaction count, so the deployer must be an ordinary
 *   account (a passkey smart account cannot `CREATE` from an EOA nonce);
 * - a **mined receipt** for every step, with `status`, so a reverted step is
 *   data the state machine can retry rather than an unknown "submitted";
 * - the **created address** from that receipt.
 *
 * Every read goes through the same wallet provider that signs, so the nonce
 * used to predict a `CREATE` address and the chain the transaction lands on
 * are one source of truth — and the chain is checked before anything is sent.
 *
 * Bounded (Review-Proven Rule 4): receipt polling has an interval and a
 * deadline; there are no retries here — the flow's own retry plan owns those.
 */

import type {
  AuctionEffects,
  AuctionSendCall,
  AuctionTxReceipt,
} from "./auctionFlow.ts";
import { decodeQuantity } from "../chain.ts";
import { walletError } from "./wallet-errors.ts";
import type { Eip1193ProviderLike } from "./wallet-sender.ts";

// Re-exported: callers (and the tests) have always imported it from here.
export { walletError };

/** How often the receipt is polled. */
export const RECEIPT_POLL_MS = 1500;
/** Give up waiting for a receipt after this long (the tx may still land). */
export const RECEIPT_TIMEOUT_MS = 180_000;

export interface WalletEffectsInput {
  provider: Eip1193ProviderLike;
  /** The signing account; also the `CREATE`-address prediction input. */
  deployer: string;
  /** The chain the launch is on; the wallet must be on it before any send. */
  chainId: number;
  /** Test seam: receipt poll interval. */
  pollMs?: number;
  /** Test seam: receipt deadline. */
  timeoutMs?: number;
  /** Test seam: async sleep (defaults to `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: monotonic clock in ms (defaults to `Date.now`). */
  now?: () => number;
}

function hexQuantity(value: unknown, what: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`the wallet returned a non-string ${what}`);
  }
  return decodeQuantity(value);
}

/**
 * Build the {@link AuctionEffects} for one connected wallet account.
 *
 * `send` resolves only once the transaction is mined; a mined revert resolves
 * with `status: "reverted"`; a rejected request or a receipt that never arrives
 * rejects (the flow reports that as "outcome unknown", never as success).
 */
export function makeWalletAuctionEffects(
  input: WalletEffectsInput,
): AuctionEffects {
  const { provider, deployer, chainId } = input;
  const pollMs = input.pollMs ?? RECEIPT_POLL_MS;
  const timeoutMs = input.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;

  const request = async (method: string, params: unknown[] = []) => {
    try {
      return await provider.request({ method, params });
    } catch (error) {
      throw walletError(error);
    }
  };

  let chainChecked = false;
  const requireChain = async (): Promise<void> => {
    if (chainChecked) return;
    const actual = Number(
      hexQuantity(await request("eth_chainId"), "chain id"),
    );
    if (actual !== chainId) {
      throw new Error(
        `Your wallet is on chain ${actual}, but this launch is on chain ${chainId}. Switch networks in your wallet and try again.`,
      );
    }
    chainChecked = true;
  };

  return {
    call: async ({ to, data }) => {
      const result = await request("eth_call", [{ to, data }, "latest"]);
      if (typeof result !== "string") {
        throw new Error("the wallet returned a non-string call result");
      }
      return result;
    },

    send: async (call: AuctionSendCall): Promise<AuctionTxReceipt> => {
      await requireChain();
      const tx: Record<string, string> = {
        from: deployer,
        data: call.data,
        value: call.value ?? "0x0",
      };
      // Contract creation is keyed on the ABSENCE of `to` (never null/empty).
      if (call.to !== undefined) tx.to = call.to;
      const hash = await request("eth_sendTransaction", [tx]);
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("the wallet did not return a transaction hash");
      }

      const deadline = now() + timeoutMs;
      for (;;) {
        const receipt = (await request("eth_getTransactionReceipt", [
          hash,
        ])) as {
          status?: string;
          blockNumber?: string;
          gasUsed?: string;
          contractAddress?: string | null;
        } | null;
        if (receipt) {
          return {
            txHash: hash,
            status: receipt.status === "0x1" ? "success" : "reverted",
            blockNumber: Number(hexQuantity(receipt.blockNumber, "block")),
            gasUsed: hexQuantity(receipt.gasUsed ?? "0x0", "gas").toString(),
            contractAddress: receipt.contractAddress ?? null,
          };
        }
        if (now() >= deadline) {
          throw new Error(
            `Transaction ${hash} was sent but not confirmed within ${Math.round(timeoutMs / 1000)}s. Check your wallet or a block explorer; if it landed, retry and this step will detect it.`,
          );
        }
        await sleep(pollMs);
      }
    },

    codeAt: async (address) => {
      const code = await request("eth_getCode", [address, "latest"]);
      if (typeof code !== "string") {
        throw new Error("the wallet returned a non-string code result");
      }
      return code !== "0x" && code !== "0x0";
    },

    transactionCount: async () =>
      hexQuantity(
        await request("eth_getTransactionCount", [deployer, "latest"]),
        "transaction count",
      ),

    blockNumber: async () =>
      hexQuantity(await request("eth_blockNumber"), "block number"),
  };
}
