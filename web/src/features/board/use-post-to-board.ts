/**
 * Posting to a board from the Home composer: the boards to offer (the ones you joined first, then the rest by name),
 * and sending a post to one of them. The board feed is read again afterwards so the post shows in Home's timeline.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useChannels } from "@/features/channels/use-channels";
import { publishAsUser } from "@/shared/lib/publish-as-user";

import { postDraft } from "./lib/board-events";
import { draftProblem } from "./lib/post-text";
import { useMyBoards } from "./use-my-boards";

export interface BoardChoice {
  id: string;
  name: string;
  joined: boolean;
}

export function usePostToBoard() {
  const channels = useChannels();
  const mine = useMyBoards();
  const queryClient = useQueryClient();
  const boards = useMemo<BoardChoice[]>(
    () =>
      channels.channels
        .filter((channel) => channel.type === "forum")
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          joined: mine.joined.has(channel.id),
        }))
        .sort(
          (a, b) =>
            Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name),
        ),
    [channels.channels, mine.joined],
  );

  /** Send a post to a board. Throws a plain sentence when the draft or the server says no. */
  const post = useCallback(
    async (boardId: string, title: string, body: string) => {
      const problem = draftProblem(title, body);
      if (problem) throw new Error(problem);
      const signed = await publishAsUser(
        postDraft({ boardId, title, body }),
        "The server didn't accept your post. Try again.",
      );
      void queryClient.invalidateQueries({ queryKey: ["board-feed"] });
      void queryClient.invalidateQueries({ queryKey: ["board", boardId] });
      return signed;
    },
    [queryClient],
  );

  /** True while the board list is still being read: not the same as "there are none". */
  const loading = channels.isLoading;

  return { boards, loading, post };
}
