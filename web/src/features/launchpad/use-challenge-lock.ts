import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { keepIfSame } from "./keep-previous";
import {
  type ChallengeLockView,
  findChallengeLock,
  readChallengeVoter,
} from "./lib/milestone-challenge";
import { endpointChain } from "./use-work";

/**
 * The milestone lock of a DAO whose milestones unlock unless holders object, or null when its lock is a panel's (or it has
 * none). Read from the DAO's own Shares, not from a record. Keyed under `["launchpad", "challenge"]`, which every
 * transaction the screen sends re-reads.
 */
export function challengeLockQuery(dao: string | null) {
  return {
    queryKey: ["launchpad", "challenge", dao],
    enabled: dao !== null,
    queryFn: (): Promise<ChallengeLockView | null> =>
      findChallengeLock(endpointChain(getRpcEndpoint()), dao as string),
    placeholderData: keepIfSame(2, dao),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  };
}

export function useChallengeLock(dao: string | null) {
  return useQuery(challengeLockQuery(dao));
}

/** What the connected wallet's vote would count for on each milestone, and whether it has already voted. */
export function useChallengeViewers(
  lock: string | null,
  wallet: string | null,
  count: number,
) {
  return useQuery({
    queryKey: ["launchpad", "challenge", lock, "viewers", wallet, count],
    enabled: lock !== null && wallet !== null && count > 0,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      return Promise.all(
        Array.from({ length: count }, (_, index) =>
          readChallengeVoter(chain, lock as string, index, wallet as string),
        ),
      );
    },
    placeholderData: (previous) => previous,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
