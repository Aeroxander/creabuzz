import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { workBounty } from "./chain-config";
import { readWorkBounties } from "./lib/work-bounty";
import type { WorkSnapshot } from "./lib/work-read";
import { endpointChain } from "./use-work";

/**
 * The bounties on a DAO's work areas (N1), when this build names a bounty contract for the project's chain. Keyed under
 * the work query, so a step sent from the Work tab re-reads them with everything else. The milestone panel is left out:
 * its "work areas" are the team's milestones, which a bounty cannot pay.
 */
export function useWorkBounties(
  chainId: string | null,
  dao: string,
  wallet: string | null,
  work: WorkSnapshot | undefined,
) {
  const contract = workBounty(chainId);
  const mandates = (work?.mandates ?? [])
    .filter((m) => !m.isMilestonePanel)
    .map((m) => m.address);
  const query = useQuery({
    queryKey: [
      "launchpad",
      "work",
      dao,
      "bounties",
      wallet,
      contract,
      mandates.join(","),
    ],
    enabled: contract !== null && mandates.length > 0,
    queryFn: () =>
      readWorkBounties(
        endpointChain(getRpcEndpoint()),
        contract as string,
        mandates,
        wallet,
      ),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  return { contract, ...query };
}
