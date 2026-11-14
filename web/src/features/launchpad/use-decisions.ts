import { useQuery } from "@tanstack/react-query";
import { keepIfSame } from "./keep-previous";

import { ethCall, ethTransactionInput, getRpcEndpoint } from "./chain";
import {
  type DecisionChain,
  readDecisions,
} from "@creaton/core/launchpad/decisions.ts";
import { readFundingContract } from "@creaton/core/launchpad/fundingTerms.ts";
import {
  decodeAddress,
  encodeCall0,
  SIGNATURES,
} from "@creaton/core/launchpad/work.ts";
import { endpointChain } from "./use-work";

/** The configured RPC endpoint as the decisions reader's chain: the work reader's, plus a transaction's calldata. */
function decisionChain(endpoint: string): DecisionChain {
  return {
    ...endpointChain(endpoint),
    input: (hash) => ethTransactionInput(endpoint, hash),
  };
}

/** How a DAO's decisions are read (one definition, for one DAO or many). */
export function decisionsQuery(dao: string | null, wallet: string | null) {
  return {
    queryKey: ["launchpad", "work", dao, "decisions", wallet],
    enabled: dao !== null,
    placeholderData: keepIfSame(2, dao),
    queryFn: () =>
      readDecisions(decisionChain(getRpcEndpoint()), dao as string, wallet),
    staleTime: 8_000,
    refetchInterval: (query: { state: { status: string } }) =>
      query.state.status === "error" ? (false as const) : 15_000,
    refetchOnWindowFocus: false,
  };
}

/**
 * A DAO's decisions read from the chain: every proposal it opened, where it stands, and what the connected wallet may
 * do about it. Keyed under the work query so a step that re-reads the work re-reads this too.
 */
export function useDecisions(dao: string | null, wallet: string | null) {
  return useQuery(decisionsQuery(dao, wallet));
}

/** How the contracts a decision's forms need to name are read (one definition, for one DAO or many). */
export function decisionContextQuery(dao: string | null) {
  return {
    queryKey: ["launchpad", "work", dao, "context"],
    enabled: dao !== null,
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
      const policy = decodeAddress(
        await ethCall(endpoint, dao as string, encodeCall0(SIGNATURES.policy)),
      );
      const [factory, shares] = await Promise.all([
        ethCall(endpoint, policy, encodeCall0(SIGNATURES.factory)),
        ethCall(endpoint, dao as string, encodeCall0("shares()")),
      ]);
      const factoryAddress = decodeAddress(factory);
      return {
        policy,
        factory: factoryAddress,
        shares: decodeAddress(shares),
        // The funding-terms contract of this DAO's summoner (D133): present,
        // absent (a factory from before it), or unreadable — never a failed read
        // folded into "absent".
        fundingTerms: await readFundingContract(
          endpointChain(endpoint),
          factoryAddress,
        ),
      };
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  };
}

/** The contracts a decision's forms need to name: the DAO's voting policy, its work budget factory and its Shares. */
export function useDecisionContext(dao: string | null) {
  return useQuery(decisionContextQuery(dao));
}
