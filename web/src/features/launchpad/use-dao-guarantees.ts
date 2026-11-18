import { useQuery } from "@tanstack/react-query";

import { ethCall, getRpcEndpoint } from "./chain";
import { readDaoGuarantees } from "./lib/dao-guarantees";

/**
 * What the DAO guarantees an outvoted holder (leaving, and today's notice before a decision runs), read from the DAO and
 * its voting policy. `policy` is null until the DAO's voting policy is known.
 */
export function useDaoGuarantees(dao: string | null, policy: string | null) {
  return useQuery({
    // Under the DAO's work key, so a decision that changes the settings reads them again.
    queryKey: ["launchpad", "work", dao, "guarantees", policy],
    enabled: dao !== null && policy !== null,
    queryFn: () => {
      const endpoint = getRpcEndpoint();
      return readDaoGuarantees(
        (to, data) => ethCall(endpoint, to, data),
        dao as string,
        policy as string,
      );
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
