import { useQuery } from "@tanstack/react-query";

import {
  ethBlockNumber,
  ethBlockTimestamps,
  ethCall,
  ethGetLogs,
  getRpcEndpoint,
} from "./chain";
import { readWork, type WorkChain } from "./lib/work-read";

/** The configured RPC endpoint as the reader's chain: whole-history log reads for one address and topic filter. */
function endpointChain(endpoint: string): WorkChain {
  return {
    now: async () => {
      const head = Number(await ethBlockNumber(endpoint));
      const [sample] = await ethBlockTimestamps(endpoint, [head]);
      if (!sample) throw new Error("the chain did not report its latest block");
      return sample.timestampSeconds;
    },
    call: (to, data) => ethCall(endpoint, to, data),
    logs: (filter) =>
      ethGetLogs(endpoint, {
        address: filter.address,
        topics: [...filter.topics],
        fromBlock: "0x0",
        toBlock: "latest",
      }),
  };
}

/** A DAO's contributor work (mandates, projects, claims), read from the launch's configured RPC. */
export function useWork(dao: string | null, wallet: string | null) {
  return useQuery({
    queryKey: ["launchpad", "work", dao, wallet],
    enabled: dao !== null,
    queryFn: () =>
      readWork(endpointChain(getRpcEndpoint()), dao as string, wallet),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
