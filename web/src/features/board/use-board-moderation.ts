/**
 * A board's moderation: its state record (rules, pinned and locked threads, moderators) and its public log, both written
 * by the server, read once and then followed live; and the commands the reader can send. Each command is one signed
 * record; the server decides, and its reason is shown as it is said when it refuses.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import type { BoardEvent } from "./lib/board-model";
import {
  appointDraft,
  type BoardState,
  boardRefusalText,
  dismissDraft,
  KIND_BOARD_MODERATION_LOG,
  KIND_BOARD_STATE,
  type LogEntry,
  muteDraft,
  parseBoardState,
  parseLog,
  rulesDraft,
  type ThreadAction,
  threadDraft,
  unmuteDraft,
} from "./lib/board-moderation";

/** The newest log entries a board shows. */
export const LOG_LIMIT = 200;

async function fetchModeration(boardId: string): Promise<BoardEvent[]> {
  const url = relayWsUrl();
  const [state, log] = await Promise.all([
    queryEvents(url, { kinds: [KIND_BOARD_STATE], "#h": [boardId], limit: 5 }),
    queryEvents(url, {
      kinds: [KIND_BOARD_MODERATION_LOG],
      "#h": [boardId],
      limit: LOG_LIMIT,
    }),
  ]);
  return [...state, ...log];
}

export interface BoardModeration {
  state: BoardState;
  log: LogEntry[];
  isLoading: boolean;
  error: unknown;
}

export function useBoardModerationRecords(boardId: string): BoardModeration {
  const query = useQuery({
    queryKey: ["board-moderation", boardId],
    queryFn: () => fetchModeration(boardId),
    staleTime: 30_000,
  });
  const [live, setLive] = useState<Map<string, BoardEvent>>(() => new Map());

  useEffect(() => {
    setLive(new Map());
    const since = Math.floor(Date.now() / 1000) - 10;
    const keep = (event: BoardEvent) =>
      setLive((previous) => new Map(previous).set(event.id, event));
    const stops = [
      subscribeChannel(
        relayWsUrl(),
        // By `#h`: the server delivers a board's records live only to subscriptions that name the board that way.
        { kinds: [KIND_BOARD_STATE], "#h": [boardId], since },
        { onEvent: keep },
      ),
      subscribeChannel(
        relayWsUrl(),
        { kinds: [KIND_BOARD_MODERATION_LOG], "#h": [boardId], since },
        { onEvent: keep },
      ),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [boardId]);

  return useMemo(() => {
    const byId = new Map<string, BoardEvent>();
    for (const event of query.data ?? []) byId.set(event.id, event);
    for (const event of live.values()) byId.set(event.id, event);
    const events = [...byId.values()];
    return {
      state: parseBoardState(events, boardId),
      log: parseLog(events, boardId),
      isLoading: query.isLoading,
      error: query.error,
    };
  }, [query.data, query.isLoading, query.error, live, boardId]);
}

/** The commands, each throwing with the server's reason when it refuses. */
export function useBoardModerationActions(boardId: string) {
  const send = useCallback(
    async (draft: Parameters<typeof publishAsUser>[0], failure: string) => {
      try {
        return await publishAsUser(draft, failure);
      } catch (error) {
        throw new Error(
          boardRefusalText(error instanceof Error ? error.message : failure),
        );
      }
    },
    [],
  );
  return useMemo(
    () => ({
      thread: (post: string, action: ThreadAction, reason?: string) =>
        send(
          threadDraft({ boardId, post, action, reason }),
          `The server didn't ${action} that thread.`,
        ),
      mute: (person: string, until: number, reason?: string) =>
        send(
          muteDraft({ boardId, person, until, reason }),
          "The server didn't mute them.",
        ),
      unmute: (person: string) =>
        send(
          unmuteDraft({ boardId, person }),
          "The server didn't lift the mute.",
        ),
      setRules: (rules: string) =>
        send(
          rulesDraft({ boardId, rules }),
          "The server didn't save the rules.",
        ),
      appoint: (person: string, until?: number) =>
        send(
          appointDraft({ boardId, person, until }),
          "The server didn't appoint them.",
        ),
      dismiss: (person: string) =>
        send(
          dismissDraft({ boardId, person }),
          "The server didn't end that appointment.",
        ),
    }),
    [boardId, send],
  );
}

export type BoardModerationActions = ReturnType<
  typeof useBoardModerationActions
>;
