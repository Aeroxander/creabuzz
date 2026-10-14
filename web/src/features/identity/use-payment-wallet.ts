import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { resolvePaymentWallet } from "./lib/wallet-proof";

/** Public payment identity, checked locally against both Nostr and EVM signatures. */
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
  const data = useMemo(() => {
    // The expiry timer invalidates the local result even if the relay is offline.
    void tick;
    return query.data
      ? resolvePaymentWallet(query.data, pubkey, Math.floor(Date.now() / 1000))
      : undefined;
  }, [query.data, pubkey, tick]);
  useEffect(() => {
    if (data?.state !== "verified") return;
    const delay = Math.min(
      2_000_000_000,
      Math.max(1, (data.wallet.expires + 1) * 1000 - Date.now()),
    );
    const timer = window.setTimeout(() => setTick((n) => n + 1), delay);
    return () => window.clearTimeout(timer);
  }, [data]);
  return { ...query, data };
}
