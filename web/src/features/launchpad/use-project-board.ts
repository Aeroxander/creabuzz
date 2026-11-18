import { useQuery } from "@tanstack/react-query";

import { type Channel, useChannels } from "@/features/channels/use-channels";
import { channelsFromRecords } from "@/features/channels/lib/channel-records";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

const KIND_CHANNEL_METADATA = 39000;

/**
 * A project's board (D156) as a board the reader can open, or null when it is not one here: not a board, removed, or
 * private to people the reader is not among. It is taken from the community's channel list when that has it, and
 * otherwise read by its id, so a board older than the list's first page is still found.
 */
export function useProjectBoard(boardId: string | null): {
  board: Channel | null;
  loading: boolean;
  error: unknown;
  retry: () => void;
} {
  const listed = useChannels();
  const fromList =
    boardId === null
      ? null
      : (listed.channels.find(
          (channel) => channel.id === boardId && channel.type === "forum",
        ) ?? null);
  const direct = useQuery({
    queryKey: ["launchpad", "project-board", boardId],
    enabled: boardId !== null && !listed.isLoading && fromList === null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_CHANNEL_METADATA],
        "#d": [boardId as string],
        limit: 5,
      });
      return (
        channelsFromRecords(events).find(
          (channel) => channel.id === boardId && channel.type === "forum",
        ) ?? null
      );
    },
  });
  return {
    board: fromList ?? direct.data ?? null,
    loading:
      boardId !== null &&
      fromList === null &&
      (listed.isLoading || direct.isLoading),
    error: fromList ? null : direct.error,
    retry: () => void direct.refetch(),
  };
}
