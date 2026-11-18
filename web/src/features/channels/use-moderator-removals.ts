/**
 * What this room's moderators have removed, as the reader sees it, and removing someone else's message when the reader is one.
 *
 * The rules are in `lib/moderator-removals.ts`; this reads who may remove (the room's and the community's owners and admins),
 * keeps that roster current while the room is open, remembers what was removed if a moderator's role is later withdrawn, and
 * sends a removal. The server checks the sender again and refuses anyone who may not.
 */

import { useEffect, useMemo, useRef } from "react";

import { moderationDeletionDraft } from "@/features/board/lib/board-events";
import {
  useChannelRemovers,
  useRosterSync,
} from "@/features/board/use-board-members";
import { existingUserPubkey } from "@/shared/lib/identity";
import { publishAsUser } from "@/shared/lib/publish-as-user";

import {
  keepRemovals,
  type TimelineEvent,
  unfamiliarRemovers,
} from "./lib/moderator-removals";

export function useModeratorRemovals(
  channelId: string,
  events: readonly TimelineEvent[],
): {
  /** Messages a moderator has removed, for this reader. */
  removed: ReadonlySet<string>;
  /** The reader owns or administers this room or the community. */
  canRemove: boolean;
  remove: (target: string) => Promise<void>;
} {
  const me = existingUserPubkey();
  const { removers } = useChannelRemovers(channelId);
  const soFar = useRef<{ room: string; ids: ReadonlySet<string> }>({
    room: channelId,
    ids: new Set(),
  });
  const removed = useMemo(() => {
    const previous =
      soFar.current.room === channelId ? soFar.current.ids : new Set<string>();
    const ids = keepRemovals(previous, events, removers);
    soFar.current = { room: channelId, ids };
    return ids;
  }, [events, removers, channelId]);

  // A roster read once goes stale: keep it current, and read it again when someone not known to be an owner or admin sends a
  // removal (they may have been appointed since). Their removal is ignored until the roster says otherwise.
  const refreshRoster = useRosterSync(channelId);
  const unfamiliar = unfamiliarRemovers(events, removers).join(",");
  useEffect(() => {
    if (unfamiliar !== "") refreshRoster();
  }, [unfamiliar, refreshRoster]);

  return {
    removed,
    canRemove: me !== null && removers.has(me),
    remove: async (target: string) => {
      await publishAsUser(
        moderationDeletionDraft({ boardId: channelId, target }),
        "The server didn't remove that.",
      );
    },
  };
}
