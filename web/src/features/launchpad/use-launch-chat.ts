/**
 * A launch's chat rooms: create them, see who is in them, admit backers.
 *
 * Both rooms are private Buzz channels (NIP-29) owned by the founder. A private
 * room is hidden from everyone who is not in it and rejects self-join, so
 * "joining" is the founder admitting a backer with one kind 9000 write.
 * Admission writes run one after another: membership is one replaceable event,
 * and concurrent writes to it lose members to last-write-wins.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  buildAddMemberEvent,
  buildCreateChannelEvent,
} from "@/features/channels/lib/channel-create-events";
import { publishTemplate } from "@/features/channels/use-create-channel";
import { useChannels } from "@/features/channels/use-channels";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { chatAccess, pendingBackers } from "./lib/launch-chat";
import { recordToInput } from "./lib/record-input";
import { useCreateLaunch } from "./use-launches";
import type { Launch, LaunchChat } from "./models";

const KIND_CHANNEL_MEMBERS = 39002;

/** Rooms are named for the launch so they are findable in the channel list. */
function roomName(launchName: string, room: "team" | "supporters"): string {
  const base = launchName.trim().slice(0, 40) || "Launch";
  return room === "team" ? `${base} · team` : `${base} · supporters`;
}

export interface CreatedRooms {
  chat: LaunchChat;
  /** Team members the founder could not add yet; surfaced, never dropped. */
  failedTeam: string[];
}

/**
 * Create the team room and the supporters room and put the team in the first.
 * Rejects when a room cannot be created at all, so a launch is never recorded
 * as having a room that does not exist.
 */
export async function createLaunchRooms(input: {
  launchName: string;
  team: readonly string[];
}): Promise<CreatedRooms> {
  const teamRoom = crypto.randomUUID();
  const supportersRoom = crypto.randomUUID();
  await publishTemplate(
    buildCreateChannelEvent({
      id: teamRoom,
      name: roomName(input.launchName, "team"),
      visibility: "private",
      channelType: "stream",
      about: "The people building this launch.",
    }),
  );
  await publishTemplate(
    buildCreateChannelEvent({
      id: supportersRoom,
      name: roomName(input.launchName, "supporters"),
      visibility: "private",
      channelType: "stream",
      about: "Backers and the team, talking about this launch.",
    }),
  );
  const failedTeam: string[] = [];
  for (const pubkey of input.team) {
    try {
      await publishTemplate(
        buildAddMemberEvent({ channelId: teamRoom, pubkey, role: "member" }),
      );
      // The team reads the supporters room too, to answer questions.
      await publishTemplate(
        buildAddMemberEvent({
          channelId: supportersRoom,
          pubkey,
          role: "member",
        }),
      );
    } catch {
      failedTeam.push(pubkey);
    }
  }
  return { chat: { team: teamRoom, supporters: supportersRoom }, failedTeam };
}

function membersKey(channelId: string | null) {
  return ["launchpad", "chat-members", channelId];
}

/** The pubkeys in a room (kind 39002 `p` tags). Empty when it cannot be read. */
export function useChannelMembers(channelId: string | null) {
  return useQuery({
    queryKey: membersKey(channelId),
    enabled: channelId !== null,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_CHANNEL_MEMBERS],
        "#d": [channelId as string],
        limit: 5,
      });
      const latest = events.reduce<(typeof events)[number] | null>(
        (best, event) =>
          best === null || event.created_at > best.created_at ? event : best,
        null,
      );
      return new Set(
        (latest?.tags ?? [])
          .filter((tag) => tag[0] === "p" && tag.length >= 2)
          .map((tag) => tag[1].toLowerCase()),
      );
    },
  });
}

/** Everyone who recorded a bid; the pool a founder admits from. */
function bidders(launch: Launch): string[] {
  return launch.bids.map((bid) => bid.author);
}

/** The viewer's standing in a launch's chat, and the rooms they can see. */
export function useChatAccess(launch: Launch | undefined) {
  const { channels, isLoading } = useChannels();
  const viewer = existingUserPubkey();
  const visibleRooms = useMemo(
    () => new Set(channels.map((channel) => channel.id)),
    [channels],
  );
  const access = useMemo(
    () =>
      launch
        ? chatAccess({
            chat: launch.record.chat,
            visibleRooms,
            viewer,
            bidders: bidders(launch),
          })
        : "none",
    [launch, visibleRooms, viewer],
  );
  return { access, visibleRooms, loading: isLoading };
}

/** Backers waiting for the founder, and the one-click action that admits them. */
export function useAdmitBackers(launch: Launch) {
  const queryClient = useQueryClient();
  const room = launch.record.chat.supporters;
  const members = useChannelMembers(room);
  const waiting = useMemo(
    () =>
      members.data
        ? pendingBackers(
            launch.bids,
            members.data,
            launch.record.team.map((member) => member.pubkey),
          ).filter((pubkey) => pubkey !== launch.record.author)
        : [],
    [members.data, launch.bids, launch.record.team, launch.record.author],
  );
  const admit = useMutation({
    mutationFn: async (pubkeys: readonly string[]) => {
      if (!room) throw new Error("This launch has no supporters room yet.");
      const admitted: string[] = [];
      try {
        for (const pubkey of pubkeys) {
          await publishTemplate(
            buildAddMemberEvent({ channelId: room, pubkey, role: "member" }),
          );
          admitted.push(pubkey);
        }
      } finally {
        // Refetch even after a partial failure so the list shows who is in.
        await queryClient.invalidateQueries({ queryKey: membersKey(room) });
      }
      return admitted;
    },
  });
  return { waiting, admit, loadingMembers: members.isLoading };
}

/**
 * Give a launch published without rooms its two rooms: create them, then
 * republish the record naming them. Rooms first, so the record never points at
 * a room that does not exist.
 */
export function useCreateChatRooms(launch: Launch) {
  const save = useCreateLaunch();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CreatedRooms> => {
      const rooms = await createLaunchRooms({
        launchName: launch.record.name,
        team: launch.record.team.map((member) => member.pubkey),
      });
      await save.mutateAsync(
        recordToInput(launch.record, { chat: rooms.chat }),
      );
      await queryClient.invalidateQueries({ queryKey: ["channels"] });
      return rooms;
    },
  });
}
