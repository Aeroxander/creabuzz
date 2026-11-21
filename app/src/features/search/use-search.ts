import { KIND_PROFILE, KIND_TEXT_NOTE } from "@creaton/core/kinds.ts";
import { indexProfiles } from "@creaton/core/social/profiles/index-profiles.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import type { SignedEvent } from "../posts/use-posts";
import { MAX_POSTS, MAX_PEOPLE, SCAN_LIMIT } from "./search-logic";

/**
 * The newest posts (and answers), looked through in the browser for a word and for the topics people use. A post a holder
 * room keeps to itself is never in it. One read shared by the search and the topics.
 */
export function useRecentScan() {
  return useQuery({
    queryKey: ["posts", "scan"],
    staleTime: 60_000,
    queryFn: async () =>
      (await read({
        kinds: [KIND_TEXT_NOTE],
        limit: SCAN_LIMIT,
      })) as SignedEvent[],
  });
}

/** People whose profile the server's word index matches. */
export function usePeopleSearch(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ["search", "people", query],
    enabled,
    staleTime: 30_000,
    queryFn: async () =>
      indexProfiles(
        await read({
          kinds: [KIND_PROFILE],
          search: query,
          limit: MAX_PEOPLE * 4,
        }),
      ),
  });
}

/** Posts the server's word index matches (a fresh server's index may not hold posts: the scan above covers those). */
export function usePostServerSearch(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ["search", "posts", query],
    enabled,
    staleTime: 30_000,
    queryFn: async () =>
      (await read({
        kinds: [KIND_TEXT_NOTE],
        search: query,
        limit: MAX_POSTS,
      })) as SignedEvent[],
  });
}
