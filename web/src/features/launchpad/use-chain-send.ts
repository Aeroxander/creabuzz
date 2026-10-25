import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { networkLabel } from "./chain-config";
import { makeWalletAuctionEffects } from "./lib/wallet-effects";
import { useConnectedWallet } from "./use-connected-wallet";

/**
 * Sending one transaction as the connected wallet on the build's own network, for a screen that is not a project's page
 * (a bounty on a post). Like `useWalletSend`: it says why it cannot send (no wallet, the wrong network), keeps one send
 * going at a time, and re-reads every query under `refresh` once the transaction landed.
 */
export function useChainSend(chainId: number, refresh: readonly unknown[]) {
  const wallet = useConnectedWallet();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = !wallet.address
    ? "Connect your wallet to act on this."
    : wallet.chainId !== null && wallet.chainId !== chainId
      ? `Your wallet is on ${networkLabel(wallet.chainId)}, but this is on ${networkLabel(chainId)}. Switch networks in your wallet.`
      : null;

  /** Send one transaction; true once it landed and the page re-read what it shows. */
  const send = async (
    key: string,
    to: string,
    data: string,
  ): Promise<boolean> => {
    if (!wallet.wallet || gate) return false;
    setBusy(key);
    setFailure(null);
    try {
      const effects = makeWalletAuctionEffects({
        provider: wallet.wallet.provider,
        deployer: wallet.wallet.address,
        chainId,
      });
      const receipt = await effects.send({ to, data });
      if (receipt.status !== "success") {
        throw new Error("The network rejected that step, so nothing changed.");
      }
      await queryClient.invalidateQueries({ queryKey: [...refresh] });
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { wallet, gate, busy, failure, send };
}
