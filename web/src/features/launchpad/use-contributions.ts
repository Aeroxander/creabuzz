import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { readContributions } from "./lib/contributions";
import { endpointChain } from "./use-work";

/**
 * Who earned the DAO's Shares for accepted work, read from the chain with no wallet. Keyed under the work query, so a
 * step that re-reads the work (an award that just ran) re-reads this too.
 */
export function useContributions(dao: string | null) {
  return useQuery({
    queryKey: ["launchpad", "work", dao, "contributions"],
    enabled: dao !== null,
    queryFn: () =>
      readContributions(endpointChain(getRpcEndpoint()), dao as string),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
