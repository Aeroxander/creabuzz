/**
 * The boards the reader has joined (or started), and joining and leaving them.
 *
 * Joining an open board is one signed request; the server then rewrites the board's member list. The answer is shown
 * at once and the list is read again, so "Your boards" never waits on the server's rewrite.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { KIND_BOARD_MEMBERS, membershipDraft } from "./lib/board-events";
import { joinedBoards } from "./lib/members";

export interface MyBoards {
  /** Board id → the reader's role on it. Empty for a signed-out reader. */
  joined: ReadonlyMap<string, string>;
  isLoading: boolean;
  /** The member lists could not be read: `joined` is then unknown, not empty. */
  failed: boolean;
  retry: () => void;
  /** Join (true) or leave (false) a board. Throws with a plain message when the server refuses. */
  setJoined: (boardId: string, join: boolean) => Promise<void>;
}

export function useMyBoards(): MyBoards {
  const me = existingUserPubkey();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["my-boards", me],
    queryFn: async () =>
      joinedBoards(
        await queryEvents(relayWsUrl(), {
          kinds: [KIND_BOARD_MEMBERS],
          "#p": [me as string],
          limit: 500,
        }),
        me as string,
      ),
    enabled: me !== null,
    staleTime: 60_000,
  });
  // What the reader just did, until the server's member list says the same.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  // Drop what the server's list now agrees with, so a later change on the server (being removed) is not hidden.
  useEffect(() => {
    const listed = query.data;
    if (!listed) return;
    setPending((previous) => {
      const next = new Map(
        [...previous].filter(([board, join]) => listed.has(board) !== join),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [query.data]);

  const joined = useMemo(() => {
    const map = new Map(query.data ?? []);
    for (const [board, join] of pending) {
      if (join && !map.has(board)) map.set(board, "member");
      if (!join) map.delete(board);
    }
    return map;
  }, [query.data, pending]);

  const setJoined = useCallback(
    async (boardId: string, join: boolean) => {
      await publishAsUser(
        membershipDraft({ boardId, join }),
        join
          ? "The server didn't let you join that board. Try again."
          : "The server didn't let you leave that board. Try again.",
      );
      setPending((previous) => new Map(previous).set(boardId, join));
      void queryClient.invalidateQueries({ queryKey: ["my-boards", me] });
    },
    [queryClient, me],
  );

  return {
    joined,
    isLoading: me !== null && query.isLoading,
    failed: me !== null && query.isError,
    retry: () => void query.refetch(),
    setJoined,
  };
}
