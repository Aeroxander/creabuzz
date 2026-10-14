import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { walletChainChecker } from "./lib/wallet-chain";
import {
  confirmPaymentWallet,
  resolvePaymentWallet,
  type PaymentWalletResult,
} from "./lib/wallet-proof";

/**
 * Public payment identity, checked locally against both Nostr and EVM signatures. An ordinary wallet's proof is
 * checked right here; a smart account's (a passkey account) is checked by asking the account on chain, so it waits
 * for that answer before it is ever shown as verified.
 */
export function usePaymentWallet(pubkey: string) {
  const relay = relayWsUrl();
  const [tick, setTick] = useState(0);
  const query = useQuery({
    queryKey: ["identity", "payment-wallet", relay, pubkey],
    queryFn: () =>
      queryEvents(relay, {
        kinds: [KIND_EVM_BINDING],
        authors: [pubkey],
        limit: 50,
      }),
    enabled: /^[0-9a-f]{64}$/.test(pubkey),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });
  const local = useMemo<PaymentWalletResult | undefined>(() => {
    // The expiry timer invalidates the local result even if the relay is offline.
    void tick;
    return query.data
      ? resolvePaymentWallet(query.data, pubkey, Math.floor(Date.now() / 1000))
      : undefined;
  }, [query.data, pubkey, tick]);
  const owed = local?.state === "unchecked" ? local : null;
  const chain = useQuery({
    queryKey: [
      "identity",
      "payment-wallet-chain",
      relay,
      pubkey,
      owed?.wallet.event.id ?? null,
    ],
    enabled: owed !== null,
    queryFn: () =>
      confirmPaymentWallet(owed as PaymentWalletResult, walletChainChecker()),
    staleTime: 30_000,
    retry: false,
  });
  const data = owed ? chain.data : local;
  useEffect(() => {
    if (data?.state !== "verified") return;
    const delay = Math.min(
      2_000_000_000,
      Math.max(1, (data.wallet.expires + 1) * 1000 - Date.now()),
    );
    const timer = window.setTimeout(() => setTick((n) => n + 1), delay);
    return () => window.clearTimeout(timer);
  }, [data]);
  return {
    ...query,
    data,
    isLoading: query.isLoading || (owed !== null && chain.isLoading),
  };
}
