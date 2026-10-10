/**
 * Every thread on this community's boards that says it is about one of a DAO's
 * decisions, found with one read per board (the server filters by topic) and
 * grouped by decision.
 *
 * A board the reader cannot open (a private one) is skipped, as it should be;
 * but if every board they can open fails to read, that is an error, never an
 * empty list that looks like "nobody has discussed anything".
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { type Channel, useChannels } from "@/features/channels/use-channels";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { KIND_FORUM_POST } from "./lib/board-events";
import { PROPOSAL_TOPIC } from "./lib/proposal-link";
import {
  groupProposalThreads,
  type ProposalThread,
} from "./lib/proposal-threads";

const READ_LIMIT = 200;

export interface DaoThreads {
  /** The boards a discussion could be started on. */
  boards: Channel[];
  /** The threads for each decision id. */
  threads: Map<string, ProposalThread[]>;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useDaoThreads(chainId: number | null, dao: string): DaoThreads {
  const { channels, isLoading: channelsLoading } = useChannels();
  const boards = useMemo(
    () => channels.filter((channel) => channel.type === "forum"),
    [channels],
  );
  const query = useQuery({
    queryKey: [
      "dao-threads",
      chainId,
      dao.toLowerCase(),
      boards.map((board) => board.id).join(","),
    ],
    enabled: chainId !== null && boards.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const url = relayWsUrl();
      const settled = await Promise.allSettled(
        boards.map(async (board) => {
          const posts = await queryEvents(url, {
            kinds: [KIND_FORUM_POST],
            "#h": [board.id],
            "#t": [PROPOSAL_TOPIC],
            limit: READ_LIMIT,
          });
          return posts.map((post) => ({
            boardId: board.id,
            boardName: board.name,
            post,
          }));
        }),
      );
      const readable = boards
        .map((board, index) => ({ board, result: settled[index] }))
        .filter(({ board }) => board.visibility !== "private");
      const failures = readable.filter(
        ({ result }) => result.status === "rejected",
      );
      if (readable.length > 0 && failures.length === readable.length) {
        throw (failures[0].result as PromiseRejectedResult).reason;
      }
      const found = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      return groupProposalThreads(found, chainId as number, dao);
    },
  });
  return {
    boards,
    threads: query.data ?? new Map(),
    isLoading:
      channelsLoading || (query.isLoading && query.fetchStatus !== "idle"),
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
