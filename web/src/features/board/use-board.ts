/**
 * A board's records: what the server holds, plus whatever arrives while the
 * board is open.
 *
 * History is three bounded reads (posts, comments, votes) and the live part is
 * one subscription, so a new reply, vote or post shows up without a reload.
 * Things the reader just wrote are merged in as soon as the server accepts
 * them, so the screen never waits for them to come back.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  subscribeChannel,
  type SubscriptionStatus,
} from "@/features/channels/subscribe-channel";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  KIND_DELETION,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_MODERATION_DELETE,
} from "./lib/board-events";
import type { BoardEvent } from "./lib/board-model";

/** Bounds on one read. A board past these shows its newest, and says so. */
export const POST_LIMIT = 200;
export const COMMENT_LIMIT = 1000;
export const VOTE_LIMIT = 3000;

async function fetchBoard(boardId: string): Promise<BoardEvent[]> {
  const url = relayWsUrl();
  const read = (kind: number, limit: number) =>
    queryEvents(url, { kinds: [kind], "#h": [boardId], limit });
  const [posts, comments, votes] = await Promise.all([
    read(KIND_FORUM_POST, POST_LIMIT),
    read(KIND_FORUM_COMMENT, COMMENT_LIMIT),
    read(KIND_FORUM_VOTE, VOTE_LIMIT),
  ]);
  return [...posts, ...comments, ...votes];
}

export interface BoardRecords {
  events: BoardEvent[];
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  /** `open` once the live connection is up; null before the first attempt. */
  liveStatus: SubscriptionStatus | null;
  /** The server's reason when it refused live updates for good (`liveStatus` is `refused`). */
  liveRefusal: string | null;
  /** Merge in a record the server just accepted. */
  add: (event: BoardEvent) => void;
  /** The newest posts only: the board has more than one read returns. */
  truncated: boolean;
}

export function useBoardRecords(boardId: string | null): BoardRecords {
  const query = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => fetchBoard(boardId ?? ""),
    enabled: boardId !== null,
    staleTime: 30_000,
  });
  const [live, setLive] = useState<Map<string, BoardEvent>>(() => new Map());
  const [liveStatus, setLiveStatus] = useState<SubscriptionStatus | null>(null);
  const [liveRefusal, setLiveRefusal] = useState<string | null>(null);

  // A different board starts with nothing live.
  useEffect(() => {
    setLive(new Map());
    setLiveStatus(null);
    setLiveRefusal(null);
    if (boardId === null) return;
    // A few seconds before now, so nothing sent while the history read was in
    // flight is missed; whatever the history also holds is merged by id.
    const since = Math.floor(Date.now() / 1000) - 10;
    return subscribeChannel(
      relayWsUrl(),
      {
        kinds: [
          KIND_FORUM_POST,
          KIND_FORUM_COMMENT,
          KIND_FORUM_VOTE,
          KIND_DELETION,
          // A moderator's removal: the board applies it when the sender is one of its owners or admins.
          KIND_MODERATION_DELETE,
        ],
        "#h": [boardId],
        since,
      },
      {
        onEvent: (event) =>
          setLive((previous) => new Map(previous).set(event.id, event)),
        onStatus: (status, reason) => {
          setLiveStatus(status);
          setLiveRefusal(status === "refused" ? (reason ?? null) : null);
        },
      },
    );
  }, [boardId]);

  const add = useCallback(
    (event: BoardEvent) =>
      setLive((previous) => new Map(previous).set(event.id, event)),
    [],
  );

  const events = useMemo(() => {
    const byId = new Map<string, BoardEvent>();
    for (const event of query.data ?? []) byId.set(event.id, event);
    for (const event of live.values()) byId.set(event.id, event);
    return [...byId.values()];
  }, [query.data, live]);

  const truncated = useMemo(
    () =>
      (query.data ?? []).filter((e) => e.kind === KIND_FORUM_POST).length >=
      POST_LIMIT,
    [query.data],
  );

  return {
    events,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
    liveStatus,
    liveRefusal,
    add,
    truncated,
  };
}
