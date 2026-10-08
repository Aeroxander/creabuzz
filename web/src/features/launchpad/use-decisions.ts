import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint, ethTransactionInput } from "./chain";
import { type DecisionChain, readDecisions } from "./lib/decisions";
import { endpointChain } from "./use-work";

/** The configured RPC endpoint as the decisions reader's chain: the work reader's, plus a transaction's calldata. */
export function decisionChain(endpoint: string): DecisionChain {
  return {
    ...endpointChain(endpoint),
    input: (hash) => ethTransactionInput(endpoint, hash),
  };
}

/**
 * A DAO's decisions read from the chain: every proposal it opened, where it stands, and what the connected wallet may
 * do about it. Keyed under the work query so a step that re-reads the work re-reads this too.
 */
export function useDecisions(dao: string | null, wallet: string | null) {
  return useQuery({
    queryKey: ["launchpad", "work", dao, "decisions", wallet],
    enabled: dao !== null,
    queryFn: () =>
      readDecisions(decisionChain(getRpcEndpoint()), dao as string, wallet),
    staleTime: 8_000,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 15_000,
    refetchOnWindowFocus: false,
  });
}
