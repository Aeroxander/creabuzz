/**
 * Suggested work for one project (D84): board posts that name it, read with one query (the server keeps them to the
 * boards this reader may see), newest first, each with where it stands against the projects the DAO approved.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { KIND_FORUM_POST } from "../board/lib/board-events";
import {
  parseWorkProposal,
  type ProposalStatus,
  proposalStatus,
  type WorkProposal,
  type WorkProposalInput,
  workProposalDraft,
  workProposalTopic,
} from "./lib/work-proposal";

const PROPOSAL_LIMIT = 200;

export interface ProposalRow extends WorkProposal {
  status: ProposalStatus;
}

export function useWorkProposals(
  chainId: string | null,
  dao: string | null,
  approved: readonly { projectId: string; checkHash: string }[],
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["launchpad", "work-proposals", chainId, dao?.toLowerCase()],
    enabled: chainId !== null && dao !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_FORUM_POST],
        "#t": [workProposalTopic(chainId as string, dao as string)],
        limit: PROPOSAL_LIMIT,
      });
      return events
        .flatMap((event) => {
          const parsed = parseWorkProposal(
            event,
            chainId as string,
            dao as string,
          );
          return parsed ? [parsed] : [];
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },
  });
  const rows = useMemo<ProposalRow[]>(
    () =>
      (query.data ?? []).map((proposal) => ({
        ...proposal,
        status: proposalStatus(proposal, approved),
      })),
    [query.data, approved],
  );

  /** Post a suggestion on a board. Throws the plain reason when it cannot be posted or the server refuses it. */
  const suggest = useCallback(
    async (input: Omit<WorkProposalInput, "chainId" | "dao">) => {
      if (chainId === null || dao === null)
        throw new Error("This project is not on a network.");
      await publishAsUser(
        workProposalDraft({ ...input, chainId, dao }),
        "The server didn't accept your suggestion.",
      );
      void queryClient.invalidateQueries({
        queryKey: ["launchpad", "work-proposals"],
      });
      void queryClient.invalidateQueries({ queryKey: ["board-feed"] });
    },
    [chainId, dao, queryClient],
  );

  return {
    rows,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
    suggest,
  };
}
