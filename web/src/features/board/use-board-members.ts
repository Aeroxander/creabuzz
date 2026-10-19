/**
 * The people who can read a private board, and adding one more.
 *
 * Reads the board's membership record. Adding is one signed "add member"
 * record from the reader; the server decides whether they may (only a board's
 * owner or an admin can), and its reason is passed on as it is said.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildAddMemberEvent } from "@/features/channels/lib/channel-create-events";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { KIND_MEMBER_LIST } from "@/features/communities/lib/access";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { useCommunityPeople } from "@/features/communities/use-access";

import { type BoardMember, boardRemovers, parseMembers } from "./lib/members";

const KIND_GROUP_MEMBERS = 39002;
const KIND_GROUP_ADMINS = 39001;

async function fetchMembers(boardId: string): Promise<BoardMember[]> {
  const records = await queryEvents(relayWsUrl(), {
    kinds: [KIND_GROUP_MEMBERS],
    "#d": [boardId],
    limit: 5,
  });
  const newest = [...records].sort((a, b) => b.created_at - a.created_at)[0];
  return newest ? parseMembers(newest.tags) : [];
}

export function useBoardMembers(boardId: string, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["board-members", boardId],
    queryFn: () => fetchMembers(boardId),
    enabled,
    staleTime: 15_000,
  });
  /** People added in this session, shown at once; the server's own record takes over on the next read. */
  const [added, setAdded] = useState<BoardMember[]>([]);

  const members = useMemo(() => {
    const byKey = new Map<string, BoardMember>();
    for (const member of [...(query.data ?? []), ...added]) {
      if (!byKey.has(member.pubkey)) byKey.set(member.pubkey, member);
    }
    return [...byKey.values()];
  }, [query.data, added]);

  const add = useCallback(
    async (pubkey: string) => {
      await publishAsUser(
        buildAddMemberEvent({ channelId: boardId, pubkey, role: "member" }),
        "The server didn't add them.",
      );
      setAdded((previous) => [...previous, { pubkey, role: "member" }]);
      void client.invalidateQueries({ queryKey: ["board-members", boardId] });
    },
    [boardId, client],
  );

  return {
    members,
    isLoading: query.isLoading,
    error: query.error,
    add,
  };
}

/**
 * Keeps who may remove things on an open board current. The board's and the community's rosters are read again when either
 * changes (someone is appointed or removed as an admin) and whenever the returned function is called, because a roster read
 * once goes stale and never refreshes by itself.
 */
export function useRosterSync(boardId: string): () => void {
  const client = useQueryClient();
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["board-members", boardId] });
    void client.invalidateQueries({ queryKey: ["community-people"] });
  }, [client, boardId]);
  useEffect(() => {
    const since = Math.floor(Date.now() / 1000) - 10;
    const stops = [
      subscribeChannel(
        relayWsUrl(),
        {
          kinds: [KIND_GROUP_ADMINS, KIND_GROUP_MEMBERS],
          "#d": [boardId],
          since,
        },
        { onEvent: refresh },
      ),
      subscribeChannel(
        relayWsUrl(),
        { kinds: [KIND_MEMBER_LIST], since },
        { onEvent: refresh },
      ),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [boardId, refresh]);
  return refresh;
}

/**
 * Who may remove other people's words in a room or on a board: its own owners and admins and the community's. Anyone else's
 * removal is not applied. The roster is read once and goes stale, so pair this with `useRosterSync`.
 */
export function useChannelRemovers(channelId: string): {
  members: BoardMember[];
  removers: ReadonlySet<string>;
} {
  const { members } = useBoardMembers(channelId, true);
  const community = useCommunityPeople();
  const removers = useMemo(() => {
    const set = new Set(boardRemovers(members));
    for (const person of community.people) {
      if (person.role === "owner" || person.role === "admin")
        set.add(person.pubkey);
    }
    return set;
  }, [members, community.people]);
  return { members, removers };
}
