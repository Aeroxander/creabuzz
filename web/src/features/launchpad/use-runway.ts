import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import type { RecordEvents } from "./lib/record-read";
import { runway } from "./lib/runway";
import { readRunwayInputs } from "./lib/runway-read";
import type { WorkSnapshot } from "./lib/work-read";
import { recordChain } from "./use-work";

/**
 * The runway card's figures (N4), keyed under the DAO's work query so a step sent from the Work tab re-reads them. Waits
 * for the work and the DAO's Shares; `record` (when each submission was paid) may still be on its way, which makes the
 * figures say they are incomplete rather than wait.
 */
export function useRunway(input: {
  dao: string;
  currency: string | null;
  shares: string | null;
  work: WorkSnapshot | undefined;
  record: RecordEvents | undefined;
  /** When the project started, in Unix seconds. */
  bornAt: number;
}) {
  const { dao, currency, shares, work, record, bornAt } = input;
  return useQuery({
    queryKey: [
      "launchpad",
      "work",
      dao,
      "runway",
      currency,
      shares,
      work?.chainTime ?? 0,
      record ? "dated" : "undated",
    ],
    enabled: currency !== null && shares !== null && work !== undefined,
    queryFn: async () => {
      const inputs = await readRunwayInputs(recordChain(getRpcEndpoint()), {
        dao,
        currency: currency as string,
        shares: shares as string,
        work: work as WorkSnapshot,
        record,
      });
      return runway({
        ...inputs,
        bornAt,
        now: (work as WorkSnapshot).chainTime,
      });
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
