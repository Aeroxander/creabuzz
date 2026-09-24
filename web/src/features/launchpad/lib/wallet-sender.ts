import type {
  CallSender,
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import { SenderCallsError } from "../../identity/lib/sponsoredSender.ts";

/** The EIP-1193-ish provider shape this sender needs from `window.ethereum`. */
export interface Eip1193ProviderLike {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Injected-wallet sender — the pre-existing `ui/RecordBidDialog.tsx` send path,
 * extracted so the bid flow can swap senders behind one {@link CallSender}
 * interface without changing the composed calldata (`sponsoredSender.test.mjs`
 * binds that parity).
 *
 * Behavior preserved exactly: `eth_requestAccounts` resolves the sending
 * account, then each call is sent in order via `eth_sendTransaction`; the
 * returned `txHash` is the LAST hash — the one the kind-47002 mirror binds.
 * The wallet decides how it lands (immediate tx or its own batching).
 */
export function createInjectedWalletSender(
  wallet: Eip1193ProviderLike | undefined,
): CallSender {
  async function requireAddress(): Promise<string> {
    if (!wallet) {
      throw new Error(
        "No wallet found in this browser. Bid on the auction contract directly, then paste the transaction hash below.",
      );
    }
    const accounts = (await wallet.request({
      method: "eth_requestAccounts",
    })) as string[];
    const address = accounts?.[0];
    if (!address) throw new Error("No account selected in the wallet.");
    return address;
  }

  return {
    isAvailable(): boolean {
      return wallet !== undefined;
    },

    getAddress(): Promise<string> {
      return requireAddress();
    },

    async sendCalls(calls: SenderCall[]): Promise<SendCallsResult> {
      if (calls.length === 0) {
        throw new SenderCallsError("sendCalls needs at least one call.");
      }
      const provider = wallet;
      if (!provider) {
        throw new Error(
          "No wallet found in this browser. Bid on the auction contract directly, then paste the transaction hash below.",
        );
      }
      const from = await requireAddress();
      // Sequential, ordered: the same calls, unmodified, one confirm each.
      let lastHash = "";
      for (const call of calls) {
        const hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from,
              to: call.to,
              value: call.value ?? "0x0",
              data: call.data,
            },
          ],
        })) as string;
        lastHash = hash;
      }
      return { txHash: lastHash, status: "submitted", userOps: [] };
    },
  };
}
