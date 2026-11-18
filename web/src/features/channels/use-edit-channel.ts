/**
 * Changing a room or board after it is made: its name, its description, and whether anyone in the community can read
 * it or only the people on its list. One signed record (kind 9002) carries every change. The server checks all of it
 * before writing anything, and lets only the room's or board's owners and admins send it; it then writes each change
 * in turn, so a failure part-way through can leave the earlier ones saved. Either way the room is read again after.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { publishAsUser } from "@/shared/lib/publish-as-user";

import {
  buildEditChannelEvent,
  type EditChannelEventInput,
} from "./lib/channel-create-events";

export function useEditChannel(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (edits: Omit<EditChannelEventInput, "channelId">) => {
      await publishAsUser(
        buildEditChannelEvent({ channelId, ...edits }),
        "The server did not save the changes.",
      );
    },
    // The server writes the new metadata record before it answers, so reading again now shows the change.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["channels"] });
      void client.invalidateQueries({
        queryKey: ["launchpad", "project-board", channelId],
      });
    },
  });
}
