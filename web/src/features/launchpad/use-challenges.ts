/**
 * The challenges published for a project's votes (`challenge.ts` in core): each one read from the project's updates and
 * shown only when its signer bound the wallet it names, the check turn-down reasons make (`fetchBoundWallets`).
 */

import { useQuery } from "@tanstack/react-query";

import {
  type Challenge,
  challengeFor,
  KIND_CHALLENGE,
  parseChallenge,
} from "@creaton/core/launchpad/challenge.ts";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { type Launch, launchCoordinate } from "./models";
import { fetchBoundWallets } from "./use-review-reasons";

/** The project's updates read to find challenges: one per vote, and a project opens far fewer votes than this. */
const MAX_UPDATES = 300;
const MAX_SIGNERS = 50;

export function useChallenges(launch: Launch) {
  const coordinate = launchCoordinate(launch.record.author, launch.record.id);
  const query = useQuery({
    queryKey: ["launchpad", "challenges", coordinate],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_CHALLENGE],
        "#a": [coordinate],
        limit: MAX_UPDATES,
      });
      const challenges = events.flatMap((event) => {
        const parsed = parseChallenge(event);
        return parsed ? [parsed] : [];
      });
      const signers = [...new Set(challenges.map((c) => c.author))]
        .sort()
        .slice(0, MAX_SIGNERS);
      const bound = signers.length
        ? await fetchBoundWallets(signers)
        : new Set<string>();
      return { challenges, bound };
    },
  });
  return {
    query,
    /** The challenge to show for a vote, or null (not challenged, or not yet read). */
    challengeOf: (decision: {
      id: string;
      proposer: string;
    }): Challenge | null =>
      query.data
        ? challengeFor(decision, query.data.challenges, query.data.bound)
        : null,
  };
}
