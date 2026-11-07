/**
 * Whether a contributor project's DAO was made by the contributor kit this build names, read from the kit's own launch
 * event (`ContributorProjectLaunched`, or `ContributorProjectLaunchedV2` from the weekly-sale kit; the DAO indexed). The
 * record alone only claims it. One read, kept: it never changes.
 */

import { useQuery } from "@tanstack/react-query";

import { ethGetLogs, getRpcEndpoint } from "./chain";
import { contributorKit } from "./chain-config";
import { kitLaunchLogs, type Provenance } from "./lib/contributor-status";
import { addressTopic } from "@creaton/core/launchpad/work.ts";

export function useContributorProvenance(
  chainId: string | null,
  dao: string | null,
): { provenance: Provenance; kit: string | null } {
  const kit = contributorKit(chainId);
  const launched = useQuery({
    queryKey: ["launchpad", "contributor-provenance", chainId, kit, dao],
    enabled: kit !== null && dao !== null,
    // Either launch event counts: the plain kit's, or the weekly-sale kit's own (`lib/contributor-status.ts`).
    queryFn: async () =>
      (
        await kitLaunchLogs(
          (topics) =>
            ethGetLogs(getRpcEndpoint(), {
              address: kit as string,
              topics,
              fromBlock: "0x0",
              toBlock: "latest",
            }),
          addressTopic(dao as string),
        )
      ).length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const provenance: Provenance =
    kit === null || dao === null
      ? "record"
      : launched.isLoading
        ? "reading"
        : launched.data === true
          ? "kit"
          : "record";
  return { provenance, kit };
}
