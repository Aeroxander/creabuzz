import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { readPayouts } from "@creaton/core/launchpad/payouts.ts";
import { endpointChain } from "./use-work";

/** Where every query about payouts lives, so a step sent from one re-reads them all. */
export const PAYOUTS_QUERY = ["launchpad", "payouts"] as const;

/** A DAO's payout module (N10) and what the connected wallet can collect; null when the DAO has none. */
export function usePayouts(dao: string | null, wallet: string | null) {
  return useQuery({
    queryKey: [...PAYOUTS_QUERY, dao, wallet],
    enabled: dao !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      const [view, now] = await Promise.all([
        readPayouts(chain, dao as string, wallet),
        chain.now(),
      ]);
      return view ? { ...view, now } : null;
    },
  });
}
