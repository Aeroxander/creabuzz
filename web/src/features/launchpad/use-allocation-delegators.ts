/**
 * The holders who handed this account their vote on decisions (`lib/allocation-delegators.ts`), read once per DAO and
 * account and shared by every decision card on the page.
 */

import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { readDelegatorsTo } from "./lib/allocation-delegators";
import { endpointChain, useDaoHolders } from "./use-work";

export function useAllocationDelegators(
  dao: string,
  account: string | null,
): string[] {
  const holders = useDaoHolders(dao);
  const listed = (holders.data?.holders ?? []).map((h) => h.holder);
  const read = useQuery({
    queryKey: ["launchpad", "delegators", dao, account, listed.join(",")],
    enabled: account !== null && holders.data !== undefined,
    queryFn: () =>
      readDelegatorsTo(
        endpointChain(getRpcEndpoint()),
        dao,
        account as string,
        listed,
      ),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return read.data ?? [];
}
