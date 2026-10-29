import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

import { networkLabel } from "./chain-config";
import { accountGate } from "./lib/acting-account";
import { useActingAccount } from "./use-acting-account";

/**
 * Sending as the acting account (D139) on the build's own network, for a screen that is not a project's page (a bounty
 * on a post) or a card on its Funds tab. Like `useWalletSend`: it says why it cannot send (no account, the wrong
 * network), keeps one send going at a time, and re-reads every query under `refresh` once the step landed.
 */
export function useChainSend(chainId: number, refresh: readonly unknown[]) {
  const wallet = useActingAccount();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = accountGate(wallet, chainId, networkLabel);

  /** Send `calls` in order as one step; true once they landed and the page re-read what it shows. */
  const sendBatch = async (
    key: string,
    calls: SenderCall[],
  ): Promise<boolean> => {
    if (gate || calls.length === 0) return false;
    setBusy(key);
    setFailure(null);
    try {
      await wallet.sendCalls(calls, chainId);
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      // Re-read whatever happened, a failure too: part of a step may have landed.
      await queryClient.invalidateQueries({ queryKey: [...refresh] });
      setBusy(null);
    }
  };

  /** Send one transaction; true once it landed and the page re-read what it shows. */
  const send = (key: string, to: string, data: string): Promise<boolean> =>
    sendBatch(key, [{ to, data }]);

  return { wallet, gate, busy, failure, send, sendBatch };
}
