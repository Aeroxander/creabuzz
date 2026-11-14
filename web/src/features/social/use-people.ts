import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { KIND_PROFILE } from "@/shared/constants/kinds";

import {
  indexProfiles,
  type ProfileMetadata,
} from "../profiles/lib/index-profiles";
import { type Engagement, NO_ENGAGEMENT } from "./lib/engagement";
import { readEvents } from "./read";
import { fetchEngagement, socialKeys } from "./use-social-data";

const PROFILE_CHUNK = 50;
const ENGAGEMENT_CHUNK = 40;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Profiles for any number of people, fetched in batches so a long timeline
 * never leaves the later posts nameless. The query keys match `useProfiles`,
 * so both share one cache.
 */
export function usePeople(
  pubkeys: readonly string[],
): Record<string, ProfileMetadata> {
  const unique = useMemo(() => [...new Set(pubkeys)].sort(), [pubkeys]);
  const results = useQueries({
    queries: chunked(unique, PROFILE_CHUNK).map((authors) => ({
      queryKey: ["profiles", authors.join(",")],
      staleTime: 5 * 60_000,
      queryFn: async () =>
        indexProfiles(
          await readEvents({
            kinds: [KIND_PROFILE],
            authors,
            limit: authors.length,
          }),
        ),
    })),
  });
  return useMemo(
    () => Object.assign({}, ...results.map((r) => r.data ?? {})),
    [results],
  );
}

/** Engagement for any number of notes, fetched in batches. */
export function useEngagementMap(
  ids: readonly string[],
  viewer: string | null,
): Map<string, Engagement> {
  const unique = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const results = useQueries({
    queries: chunked(unique, ENGAGEMENT_CHUNK).map((chunk) => ({
      queryKey: [...socialKeys.engagement, chunk, viewer],
      staleTime: 15_000,
      queryFn: () => fetchEngagement(chunk, viewer),
    })),
  });
  return useMemo(() => {
    const merged = new Map<string, Engagement>();
    for (const r of results)
      for (const [id, e] of r.data ?? []) merged.set(id, e);
    return merged;
  }, [results]);
}

export function engagementOf(
  map: ReadonlyMap<string, Engagement>,
  id: string,
): Engagement {
  return map.get(id) ?? NO_ENGAGEMENT;
}
