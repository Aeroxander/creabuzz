/**
 * A launch's chat rooms: create them, see who is in them, join, admit backers.
 *
 * - The team room is private, owned by the founder.
 * - The supporters room is open: anyone joins with one kind 9021 write.
 * - The backers room is private and gated. A private room rejects self-join, so
 *   "joining" is the founder admitting a backer with one kind 9000 write.
 *
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

import {
  missingRooms,
  pendingBackers,
  type RoomKey,
  roomRows,
  withRooms,
} from "./lib/launch-chat";
import { recordToInput } from "./lib/record-input";
import { useCreateLaunch } from "./use-launches";
import type { Launch, LaunchChat } from "./models";

const KIND_CHANNEL_MEMBERS = 39002;

const ROOM_SPECS: Record<
  RoomKey,
  { suffix: string; visibility: "open" | "private"; about: string }
> = {
  team: {
    suffix: "team",
    visibility: "private",
    about: "The people building this launch.",
  },
  supporters: {
    suffix: "supporters",
    visibility: "open",
    about: "Everyone excited about this project.",
  },
  backers: {
    suffix: "backers",
    visibility: "private",
    about: "People who backed this launch with a bid.",
  },
};

/** Rooms are named for the launch so they are findable in the channel list. */
function roomName(launchName: string, room: RoomKey): string {
  const base = launchName.trim().slice(0, 40) || "Launch";
  return `${base} · ${ROOM_SPECS[room].suffix}`;
}

export interface CreatedRooms {
  /** The rooms that now exist; a room that failed is absent. */
  created: Partial<LaunchChat>;
  /** Rooms that could not be created; the founder can retry them. */
  failedRooms: RoomKey[];
  /** Team members the founder could not add yet; surfaced, never dropped. */
  failedTeam: string[];
}

/**
 * Create the requested rooms and put the team in the private ones. A room that
 * fails does not stop the others: the result says exactly what exists, so a
 * launch is only ever recorded with rooms that are real, and the missing ones
 * can be created again later.
 */
export async function createLaunchRooms(input: {
  launchName: string;
  team: readonly string[];
  rooms: readonly RoomKey[];
}): Promise<CreatedRooms> {
  const created: Partial<LaunchChat> = {};
  const failedRooms: RoomKey[] = [];
  const failedTeam = new Set<string>();
  for (const room of input.rooms) {
    const spec = ROOM_SPECS[room];
    const id = crypto.randomUUID();
    try {
      await publishTemplate(
        buildCreateChannelEvent({
          id,
          name: roomName(input.launchName, room),
          visibility: spec.visibility,
          channelType: "stream",
          about: spec.about,
        }),
      );
    } catch {
      failedRooms.push(room);
      continue;
    }
    created[room] = id;
    // Open rooms need no invitation; the team joins like anyone else.
    if (spec.visibility === "open") continue;
    for (const pubkey of input.team) {
      try {
        await publishTemplate(
          buildAddMemberEvent({ channelId: id, pubkey, role: "member" }),
        );
      } catch {
        failedTeam.add(pubkey);
      }
    }
  }
  return { created, failedRooms, failedTeam: [...failedTeam] };
}

export const EMPTY_CHAT: LaunchChat = {
  team: null,
  supporters: null,
  backers: null,
};

/**
 * Make sure a launch has the rooms it needs before its record is published:
 * creates only what is missing and returns the chat to record. `incomplete`
 * means something could not be set up, so the caller can say so; it never
 * blocks the launch, and the founder can create the rest from the launch page.
 */
export async function ensureRooms(input: {
  launchName: string;
  chat: LaunchChat;
  team: readonly string[];
  sale: boolean;
}): Promise<{ chat: LaunchChat; incomplete: boolean }> {
  const rooms = await createLaunchRooms({
    launchName: input.launchName,
    team: input.team,
    rooms: missingRooms(input.chat, { sale: input.sale }),
  });
  return {
    chat: withRooms(input.chat, rooms.created),
    incomplete: rooms.failedRooms.length > 0 || rooms.failedTeam.length > 0,
  };
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

/** The rooms the viewer sees on a launch and what they can do with each. */
export function useChatRows(launch: Launch | undefined) {
  const { channels, isLoading } = useChannels();
  const viewer = existingUserPubkey();
  const supporters = useChannelMembers(launch?.record.chat.supporters ?? null);
  const visibleRooms = useMemo(
    () => new Set(channels.map((channel) => channel.id)),
    [channels],
  );
  const rows = useMemo(
    () =>
      launch
        ? roomRows({
            chat: launch.record.chat,
            visibleRooms,
            supportersMembers: supporters.data ?? null,
            viewer,
            bidders: bidders(launch),
          })
        : [],
    [launch, visibleRooms, supporters.data, viewer],
  );
  return { rows, loading: isLoading || supporters.isLoading };
}

/** Join an open room (kind 9021). Only the supporters room is open. */
export function useJoinRoom(room: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!room) throw new Error("This launch has no supporters room yet.");
      await publishTemplate({ kind: 9021, content: "", tags: [["h", room]] });
      await queryClient.invalidateQueries({ queryKey: membersKey(room) });
    },
  });
}

/** Backers waiting for the founder, and the one-click action that admits them. */
export function useAdmitBackers(launch: Launch) {
  const queryClient = useQueryClient();
  const room = launch.record.chat.backers;
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
      if (!room) throw new Error("This launch has no backers room yet.");
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
 * Create the rooms a launch is missing, then republish the record naming them.
 * Rooms first, so the record never points at a room that does not exist.
 * Rejects when nothing could be created, so the founder sees a failure rather
 * than a silent no-op.
 */
export function useCreateChatRooms(launch: Launch, options: { sale: boolean }) {
  const save = useCreateLaunch();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CreatedRooms> => {
      const rooms = await createLaunchRooms({
        launchName: launch.record.name,
        team: launch.record.team.map((member) => member.pubkey),
        rooms: missingRooms(launch.record.chat, options),
      });
      if (Object.keys(rooms.created).length === 0) {
        throw new Error("The chat rooms could not be created. Try again.");
      }
      await save.mutateAsync(
        recordToInput(launch.record, {
          chat: withRooms(launch.record.chat, rooms.created),
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["channels"] });
      return rooms;
    },
  });
}
