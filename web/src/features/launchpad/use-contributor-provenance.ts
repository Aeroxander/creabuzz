/**
 * Whether a contributor project's DAO was made by the contributor kit this build names, read from the kit's own launch
 * event (`ContributorLaunched`, the DAO indexed). The record alone only claims it. One read, kept: it never changes.
 */

import { useQuery } from "@tanstack/react-query";

import { ethGetLogs, getRpcEndpoint } from "./chain";
import { contributorKit } from "./chain-config";
import {
  type Provenance,
  TOPIC_CONTRIBUTOR_LAUNCHED,
} from "./lib/contributor-status";
import { addressTopic } from "./lib/work";

export function useContributorProvenance(
  chainId: string | null,
  dao: string | null,
): { provenance: Provenance; kit: string | null } {
  const kit = contributorKit(chainId);
  const launched = useQuery({
    queryKey: ["launchpad", "contributor-provenance", chainId, kit, dao],
    enabled: kit !== null && dao !== null,
    queryFn: async () =>
      (
        await ethGetLogs(getRpcEndpoint(), {
          address: kit as string,
          topics: [
            TOPIC_CONTRIBUTOR_LAUNCHED,
            null,
            addressTopic(dao as string),
          ],
          fromBlock: "0x0",
          toBlock: "latest",
        })
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
