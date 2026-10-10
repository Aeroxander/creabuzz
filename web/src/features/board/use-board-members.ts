/**
 * The people who can read a private board, and adding one more.
 *
 * Reads the board's membership record. Adding is one signed "add member"
 * record from the reader; the server decides whether they may (only a board's
 * owner or an admin can), and its reason is passed on as it is said.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { buildAddMemberEvent } from "@/features/channels/lib/channel-create-events";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { type BoardMember, parseMembers } from "./lib/members";

const KIND_GROUP_MEMBERS = 39002;

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
