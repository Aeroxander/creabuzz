/**
 * Reading a project's public record as someone an invite-only server does not let in (`lib/public-record.ts`).
 *
 * The reads go over the server's HTTP door, which is where it answers people who are not on its list: at most three
 * short requests, each bounded by the server. Whether it answers at all is the server's setting; when it does not,
 * or the project is not one it shows publicly, there is no data and the page says what it said before.
 *
 * No state is kept outside React and the query cache: nothing here outlives a change of community.
 */

import { useQuery } from "@tanstack/react-query";

import { queryEventsHttp } from "@/shared/lib/http-query";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import {
  helperFilters,
  helpersNamed,
  type PublicAddress,
  type PublicRecordView,
  publicRecordView,
  recordFilters,
  recordNamed,
  teamFilters,
} from "./lib/public-record";

/** The public record of the project `address` names, or null data when the server shows none. Off when `address` is null. */
export function usePublicRecord(address: PublicAddress | null) {
  const relay = relayHttpBaseUrl();
  return useQuery({
    queryKey: [
      "launchpad",
      "public-record",
      relay,
      address?.id ?? null,
      address?.author ?? address?.founderStart ?? null,
    ],
    enabled: address !== null,
    staleTime: 30_000,
    // A refusal is the server's answer, not a fault to try again.
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<PublicRecordView | null> => {
      if (!address) return null;
      const record = recordNamed(
        address,
        await queryEventsHttp(recordFilters(address), { signal }),
      );
      if (!record) return null;
      const teamEvents = await queryEventsHttp(teamFilters(record), {
        signal,
      });
      const helpers = helperFilters(record, helpersNamed(record, teamEvents));
      const helperEvents = helpers
        ? await queryEventsHttp(helpers, { signal })
        : null;
      return publicRecordView({
        record,
        teamEvents,
        helperEvents,
        now: Math.floor(Date.now() / 1000),
      });
    },
  });
}
