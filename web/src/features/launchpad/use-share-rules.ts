import { useQuery } from "@tanstack/react-query";

import { ethCall, getRpcEndpoint } from "./chain";
import { keepIfSame } from "./keep-previous";
import { readShareRules } from "./lib/share-rules";

/**
 * What the DAO's Shares say about new Shares and trading (D76, D77), read straight from them. `shares` is null until the
 * DAO's Shares are known.
 */
export function useShareRules(shares: string | null, dao: string | null) {
  return useQuery({
    // Under the DAO's work key, so a sent decision (which refreshes that key) reads the rules again.
    queryKey: ["launchpad", "work", dao, "share-rules", shares],
    enabled: shares !== null && dao !== null,
    placeholderData: keepIfSame(2, dao),
    queryFn: () => {
      const endpoint = getRpcEndpoint();
      return readShareRules(
        (to, data) => ethCall(endpoint, to, data),
        shares as string,
        dao as string,
      );
    },
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
