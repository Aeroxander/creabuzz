import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

import { networkLabel } from "./chain-config";
import { accountGate } from "./lib/acting-account";
import type { Launch } from "./models";
import { useActingAccount } from "./use-acting-account";

function chainNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Sending as the acting account (D139: a passkey account with covered fees, or the browser's wallet), for a screen that
 * acts on a DAO: it says why it cannot (no account, the wrong network), keeps one send going at a time, and re-reads
 * everything under the DAO's work queries once the step landed.
 */
export function useWalletSend(launch: Launch, dao: string) {
  const wallet = useActingAccount();
  const queryClient = useQueryClient();
  const launchChainId = chainNumber(launch.record.chainId);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = accountGate(wallet, launchChainId, networkLabel);

  /**
   * Send `calls` in order as one step (one passkey prompt, or one wallet prompt each); true once they landed and the
   * page re-read the chain.
   */
  const sendBatch = async (
    key: string,
    calls: SenderCall[],
  ): Promise<boolean> => {
    if (launchChainId === null || gate || calls.length === 0) return false;
    setBusy(key);
    setFailure(null);
    try {
      await wallet.sendCalls(calls, launchChainId);
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      // Re-read whatever happened, a failure too: part of a step may have landed, and pressing the button again must
      // build the rest from what is on chain. Screens that act on a milestone lock read it under their own key.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["launchpad", "work", dao] }),
        queryClient.invalidateQueries({ queryKey: ["launchpad", "challenge"] }),
      ]);
      setBusy(null);
    }
  };

  /** Send one transaction; true once it landed and the page re-read the chain. */
  const send = (key: string, to: string, data: string): Promise<boolean> =>
    sendBatch(key, [{ to, data }]);

  return { wallet, gate, busy, failure, send, sendBatch };
}
