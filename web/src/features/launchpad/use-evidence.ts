import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { type EvidencePacket, packetsOf } from "./lib/evidence";
import { readEvidenceEvents } from "./lib/evidence-query";
import { launchCoordinate, parseLaunchUpdate, type Launch } from "./models";

/** The key every launch's evidence is cached under, so a publish can refresh them all. */
export const evidenceQueryKey = ["launchpad", "evidence"] as const;

/**
 * The evidence packets for a launch: those in its directory updates, and those read for the launch on its own, so an
 * old claim's evidence is still found when the directory read no longer reaches it. `error` is set when the separate
 * read failed: the page then says what it could not read instead of showing a claim as having no evidence.
 */
export function useEvidencePackets(launch: Launch): {
  packets: EvidencePacket[];
  error: boolean;
  /** The launch has more updates than were read: a claim with no evidence here may have it in an older update. */
  incomplete: boolean;
  refetch: () => void;
} {
  const coordinate = launchCoordinate(launch.record.author, launch.record.id);
  const query = useQuery({
    queryKey: [...evidenceQueryKey, coordinate],
    queryFn: async () => {
      const { events, complete } = await readEvidenceEvents(
        (filter) => queryEvents(relayWsUrl(), filter),
        coordinate,
      );
      return {
        complete,
        updates: events.flatMap((event) => {
          const update = parseLaunchUpdate(event);
          return update ? [update] : [];
        }),
      };
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const packets = useMemo(() => {
    const merged = packetsOf([
      ...launch.updates,
      ...(query.data?.updates ?? []),
    ]);
    const seen = new Set<string>();
    return merged.filter((packet) => {
      if (seen.has(packet.eventId)) return false;
      seen.add(packet.eventId);
      return true;
    });
  }, [launch.updates, query.data]);
  return {
    packets,
    error: query.isError,
    incomplete: query.data ? !query.data.complete : false,
    refetch: () => void query.refetch(),
  };
}
