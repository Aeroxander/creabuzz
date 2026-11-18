/**
 * The boards of this server, for a list of them: read a bounded step at a time (see `lib/board-pages.ts`), further
 * back only when the reader asks.
 *
 * Not the first page of the channel list, which counts chat rooms and direct-message threads too and leaves an older
 * board out on a busy server.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { Channel } from "@/features/channels/use-channels";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { boardsOfSteps, readBoardStep } from "./lib/board-pages";

export interface BoardList {
  /** Every board read so far, by name. Not the whole list while `hasMore`. */
  boards: Channel[];
  isLoading: boolean;
  /** A failed first read or refresh: there is no list to show. */
  error: unknown;
  /** Older channel records have not been looked through yet, so there may be boards not listed. */
  hasMore: boolean;
  loadingMore: boolean;
  /** A failed read further back: what was read stays, and `loadMore` tries again from where it stopped. */
  moreError: unknown;
  loadMore: () => void;
  refetch: () => void;
}

export function useBoardList(): BoardList {
  const query = useInfiniteQuery({
    // Under "channels", so whatever reads the channel list again reads this again too.
    queryKey: ["channels", "boards"],
    queryFn: ({ pageParam }) =>
      readBoardStep((filter) => queryEvents(relayWsUrl(), filter), pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (step) => step.next ?? undefined,
    staleTime: 60_000,
  });
  const steps = query.data?.pages;
  const boards = useMemo(() => boardsOfSteps(steps ?? []), [steps]);
  const { fetchNextPage, isFetchingNextPage } = query;
  return {
    boards,
    isLoading: query.isLoading,
    // A step further back that failed is not the list failing (TanStack keeps the steps read before it).
    error: query.isFetchNextPageError ? null : query.error,
    hasMore: query.hasNextPage,
    loadingMore: isFetchingNextPage,
    moreError: query.isFetchNextPageError
      ? query.error
      : (steps?.[steps.length - 1]?.failed ?? null),
    loadMore: () => {
      if (!isFetchingNextPage) void fetchNextPage();
    },
    refetch: () => void query.refetch(),
  };
}
