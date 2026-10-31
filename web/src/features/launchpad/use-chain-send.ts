import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

import { networkLabel } from "./chain-config";
import { accountGate } from "./lib/acting-account";
import { useActingAccount } from "./use-acting-account";

/**
 * The one way a screen sends as the acting account (D139: a passkey account with covered fees, or the browser's
 * wallet). It says why it cannot send (no account, the wrong network), keeps one send going at a time, and re-reads
 * every query under each `refresh` key once the step landed. A screen on a project's page uses `useWalletSend`, which
 * is this hook on the project's network; a card elsewhere (a bounty on a post, the Funds tab) calls it directly with
 * the build's network. `chainId` is null when a project names no network: nothing can be sent then.
 *
 * Only raise screens let a person pick wallet or passkey per step (`ui/SenderPicker.tsx`); everything else sends here.
 */
export function useChainSend(
  chainId: number | null,
  ...refresh: (readonly unknown[])[]
) {
  const wallet = useActingAccount();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = accountGate(wallet, chainId, networkLabel);

  /**
   * Send `calls` in order as one step (one passkey prompt, or one wallet prompt each); true once they landed and the
   * page re-read what it shows.
   */
  const sendBatch = async (
    key: string,
    calls: SenderCall[],
  ): Promise<boolean> => {
    if (chainId === null || gate || calls.length === 0) return false;
    setBusy(key);
    setFailure(null);
    try {
      await wallet.sendCalls(calls, chainId);
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      // Re-read whatever happened, a failure too: part of a step may have landed, and pressing the button again must
      // build the rest from what is on chain.
      await Promise.all(
        refresh.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey: [...queryKey] }),
        ),
      );
      setBusy(null);
    }
  };

  /** Send one transaction; true once it landed and the page re-read what it shows. */
  const send = (key: string, to: string, data: string): Promise<boolean> =>
    sendBatch(key, [{ to, data }]);

  return { wallet, gate, busy, failure, send, sendBatch };
}
