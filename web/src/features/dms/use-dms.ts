import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
/**
 * Direct-message conversations: the conversation list (relay-signed notices),
 * the hidden set (viewer visibility snapshot), live updates, and the open /
 * hide command send paths.
 *
 * Event shapes and parsing live in `@creaton/core/dm.ts`; this module is the
 * web client's transport and state wiring around them.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  buildDmHideTags,
  buildDmOpenTags,
  hiddenDmIds,
  KIND_DM_CREATED,
  KIND_DM_HIDE,
  KIND_DM_OPEN,
  KIND_DM_VISIBILITY,
  parseDmCreated,
  parseDmOpenAck,
} from "@creaton/core/dm.ts";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";

export interface DmConversation {
  /** The conversation's channel id, used as the `h` tag of its messages. */
  id: string;
  /** Participant public keys (includes the viewer). */
  participants: string[];
  createdAt: number;
}

/** One conversation-list query key, shared by the list and its refetches. */
export function dmConversationsKey(me: string | null): string[] {
  return ["dm-conversations", me ?? "none"];
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * The viewer's DM conversations, minus the ones they have hidden.
 *
 * History and the live subscription merge into one id-keyed map (monotonic:
 * an event already seen is never replaced by a different one), and the latest
 * visibility snapshot always wins for the hidden set.
 */
export function useDmConversations() {
  const me = existingUserPubkey();
  const [live, setLive] = useState<Map<string, NostrEvent>>(() => new Map());

  const query = useQuery({
    queryKey: dmConversationsKey(me),
    queryFn: () =>
      queryEvents(relayWsUrl(), {
        kinds: [KIND_DM_CREATED, KIND_DM_VISIBILITY],
        "#p": [me ?? ""],
        limit: 50,
      }),
    enabled: me != null,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (me == null) return;
    return subscribeChannel(
      relayWsUrl(),
      {
        kinds: [KIND_DM_CREATED, KIND_DM_VISIBILITY],
        "#p": [me],
        limit: 20,
      },
      {
        onEvent: (event) => {
          setLive((prev) => {
            const next = new Map(prev);
            next.set(event.id, event);
            return next;
          });
        },
      },
    );
  }, [me]);

  const { conversations, hiddenIds } = useMemo(() => {
    const all = [...(query.data ?? []), ...live.values()];
    const byId = new Map<string, DmConversation>();
    let latestSnapshot: NostrEvent | null = null;
    for (const event of all) {
      if (event.kind === KIND_DM_VISIBILITY) {
        if (
          latestSnapshot == null ||
          event.created_at > latestSnapshot.created_at
        ) {
          latestSnapshot = event;
        }
        continue;
      }
      const notice = parseDmCreated(event);
      if (notice == null) continue;
      const previous = byId.get(notice.dmId);
      if (previous == null || notice.createdAt >= previous.createdAt) {
        byId.set(notice.dmId, {
          id: notice.dmId,
          participants: notice.participants,
          createdAt: notice.createdAt,
        });
      }
    }
    const hidden = new Set(
      latestSnapshot == null ? [] : hiddenDmIds(latestSnapshot),
    );
    return {
      conversations: [...byId.values()]
        .filter((c) => !hidden.has(c.id))
        .sort((a, b) => b.createdAt - a.createdAt),
      hiddenIds: hidden,
    };
  }, [query.data, live]);

  return {
    me,
    conversations,
    hiddenIds,
    isLoading: query.isLoading,
    error: query.error,
    /** Retry the conversation list after a failure. */
    refetch: query.refetch,
  };
}

/**
 * Last-activity timestamps for the listed conversations, one bounded query
 * plus one live subscription covering all of them (the `h` filter takes
 * multiple values). Used for list ordering and unread dots.
 */
export function useDmActivity(dmIds: string[]) {
  const key = dmIds.join(",");
  const [live, setLive] = useState<Map<string, number>>(() => new Map());

  const query = useQuery({
    queryKey: ["dm-activity", key],
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
        "#h": dmIds.slice(0, 50),
        limit: 200,
      });
      const map = new Map<string, number>();
      for (const event of events) {
        const h = getTag(event, "h");
        if (h == null) continue;
        map.set(h, Math.max(map.get(h) ?? 0, event.created_at));
      }
      return map;
    },
    enabled: dmIds.length > 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (dmIds.length === 0) return;
    return subscribeChannel(
      relayWsUrl(),
      {
        kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
        "#h": dmIds.slice(0, 50),
        limit: 20,
      },
      {
        onEvent: (event) => {
          const h = getTag(event, "h");
          if (h == null) return;
          setLive((prev) => {
            const next = new Map(prev);
            next.set(h, Math.max(next.get(h) ?? 0, event.created_at));
            return next;
          });
        },
      },
    );
  }, [dmIds]);

  return useMemo(() => {
    const merged = new Map(query.data ?? []);
    for (const [id, at] of live) {
      merged.set(id, Math.max(merged.get(id) ?? 0, at));
    }
    return merged;
  }, [query.data, live]);
}

/** Timestamp a conversation was last read at (0 = never). */
export function dmLastReadAt(scope: string, dmId: string): number {
  try {
    const raw = window.localStorage.getItem(
      `buzz.dm.lastRead.${scope}.${dmId}`,
    );
    const value = raw == null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Record that a conversation was read at `at` (unix seconds). */
export function markDmRead(scope: string, dmId: string, at: number): void {
  try {
    window.localStorage.setItem(
      `buzz.dm.lastRead.${scope}.${dmId}`,
      String(at),
    );
  } catch {
    // Storage can be unavailable (private browsing); unread dots then simply
    // stay unrecorded, which is cosmetic only.
  }
}

/**
 * Open (or surface) a DM conversation.
 *
 * Sends the open command and only reports success once the server confirmed
 * the conversation's channel id — an unconfirmed open is an error the caller
 * can retry, never an optimistic phantom conversation.
 */
export function useOpenDm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (participants: string[]): Promise<string> => {
      const tags = buildDmOpenTags(participants);
      const signed = await signAsUser({
        kind: KIND_DM_OPEN,
        tags,
        content: "",
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(
          result.message ?? "the server rejected the request — try again",
        );
      }
      return parseDmOpenAck(result.message).channelId;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: dmConversationsKey(existingUserPubkey()),
      });
    },
  });
}

/** Hide a DM conversation from the viewer's listing. */
export function useHideDm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string): Promise<void> => {
      const tags = buildDmHideTags(channelId);
      const signed = await signAsUser({
        kind: KIND_DM_HIDE,
        tags,
        content: "",
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(
          result.message ?? "the server rejected the request — try again",
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: dmConversationsKey(existingUserPubkey()),
      });
    },
  });
}
