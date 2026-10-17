import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { makeWalletAuctionEffects } from "./lib/wallet-effects";
import type { Launch } from "./models";
import { useConnectedWallet } from "./use-connected-wallet";

function chainNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Sending one transaction as the connected wallet, for a screen that acts on a DAO: it says why it cannot (no wallet,
 * the wrong network), keeps one send going at a time, and re-reads everything under the DAO's work queries once the
 * transaction landed.
 */
export function useWalletSend(launch: Launch, dao: string) {
  const wallet = useConnectedWallet();
  const queryClient = useQueryClient();
  const launchChainId = chainNumber(launch.record.chainId);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = !wallet.address
    ? "Connect your wallet to act on this."
    : launchChainId !== null &&
        wallet.chainId !== null &&
        wallet.chainId !== launchChainId
      ? `Your wallet is on chain ${wallet.chainId}, but this project is on chain ${launchChainId}. Switch networks in your wallet.`
      : null;

  /** Send one transaction; true once it landed and the page re-read the chain. */
  const send = async (
    key: string,
    to: string,
    data: string,
  ): Promise<boolean> => {
    if (!wallet.wallet || launchChainId === null || gate) return false;
    setBusy(key);
    setFailure(null);
    try {
      const effects = makeWalletAuctionEffects({
        provider: wallet.wallet.provider,
        deployer: wallet.wallet.address,
        chainId: launchChainId,
      });
      const receipt = await effects.send({ to, data });
      if (receipt.status !== "success") {
        throw new Error("The network rejected that step, so nothing changed.");
      }
      // Screens that act on a milestone lock read it under their own key.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["launchpad", "work", dao] }),
        queryClient.invalidateQueries({ queryKey: ["launchpad", "challenge"] }),
      ]);
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
