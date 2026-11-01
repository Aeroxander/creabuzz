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
  type BoardMemoScope,
  type BoardMemoStore,
  boardForLaunch,
  boardIsFounders,
  forgetBoardMemo,
  missingRooms,
  pendingBackers,
  publishWithBoard,
  type RoomKey,
  roomRows,
  withRooms,
} from "./lib/launch-chat";
import { recordToInput } from "./lib/record-input";
import { useCreateLaunch } from "./use-launches";
import type { Launch, LaunchChat } from "./models";

const KIND_CHANNEL_METADATA = 39000;
const KIND_CHANNEL_ADMINS = 39001;
const KIND_CHANNEL_MEMBERS = 39002;

/** What a launch can have made for it: its chat rooms and its board (D156). */
type SpaceKey = RoomKey | "board";

const ROOM_SPECS: Record<
  SpaceKey,
  {
    suffix: string | null;
    visibility: "open" | "private";
    channelType: "stream" | "forum";
    about: (launchName: string) => string;
  }
> = {
  team: {
    suffix: "team",
    visibility: "private",
    channelType: "stream",
    about: () => "The people building this launch.",
  },
  supporters: {
    suffix: "supporters",
    visibility: "open",
    channelType: "stream",
    about: () => "Everyone excited about this project.",
  },
  backers: {
    suffix: "backers",
    visibility: "private",
    channelType: "stream",
    about: () => "People who backed this launch with a bid.",
  },
  board: {
    suffix: null,
    visibility: "open",
    channelType: "forum",
    about: (launchName) =>
      `Talk about ${launchName.trim() || "this project"}: ideas, questions and plans.`,
  },
};

/** Rooms are named for the launch so they are findable in the channel list; the board takes the launch's own name. */
function roomName(launchName: string, room: SpaceKey): string {
  const base = launchName.trim().slice(0, 40) || "Launch";
  const suffix = ROOM_SPECS[room].suffix;
  return suffix ? `${base} · ${suffix}` : base;
}

export interface CreatedRooms {
  /** The rooms that now exist; a room that failed is absent. */
  created: Partial<LaunchChat>;
  /** Rooms that could not be created; the founder can retry them. */
  failedRooms: SpaceKey[];
  /** Team members the founder could not add yet; surfaced, never dropped. */
  failedTeam: string[];
  /** Why each failed room failed, as the server said it (a refusal such as the daily limit on new boards). */
  errors: Partial<Record<SpaceKey, unknown>>;
}

/**
 * Create the requested rooms and put the team in the private ones. A room that
 * fails does not stop the others: the result says exactly what exists, so a
 * launch is only ever recorded with rooms that are real, and the missing ones
 * can be created again later.
 */
async function createLaunchRooms(input: {
  launchName: string;
  team: readonly string[];
  rooms: readonly SpaceKey[];
}): Promise<CreatedRooms> {
  const created: Partial<LaunchChat> = {};
  const failedRooms: SpaceKey[] = [];
  const errors: Partial<Record<SpaceKey, unknown>> = {};
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
          channelType: spec.channelType,
          about: spec.about(input.launchName),
        }),
      );
    } catch (error) {
      failedRooms.push(room);
      errors[room] = error;
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
  return { created, failedRooms, failedTeam: [...failedTeam], errors };
}

export const EMPTY_CHAT: LaunchChat = {
  team: null,
  supporters: null,
  backers: null,
  board: null,
};

/**
 * Make sure a launch has the rooms and the board it needs before its record is published: creates only what is missing
 * and returns the chat to record. `incomplete` means a chat room or a team member could not be set up, and
 * `boardMissing` that the board could not be, so the caller can say which (`setupNotice`); neither blocks the launch.
 * The founder adds missing rooms from the launch page's Chat card and the board from its Discussion tab.
 */
export async function ensureRooms(input: {
  launchName: string;
  chat: LaunchChat;
  team: readonly string[];
  sale: boolean;
}): Promise<{ chat: LaunchChat; incomplete: boolean; boardMissing: boolean }> {
  const rooms = await createLaunchRooms({
    launchName: input.launchName,
    team: input.team,
    rooms: [
      ...missingRooms(input.chat, { sale: input.sale }),
      ...(input.chat.board ? [] : (["board"] as const)),
    ],
  });
  const chat = withRooms(input.chat, rooms.created);
  return {
    chat,
    incomplete:
      rooms.failedRooms.some((room) => room !== "board") ||
      rooms.failedTeam.length > 0,
    boardMissing: chat.board === null,
  };
}

/** What was not set up when a launch was published, and where to add it; null when everything was. */
export function setupNotice(ensured: {
  incomplete: boolean;
  boardMissing: boolean;
}): string | null {
  if (ensured.incomplete && ensured.boardMissing) {
    return "Some chat rooms and the project's board weren't set up: add the rooms on its page, and the board from its Discussion tab.";
  }
  if (ensured.incomplete) return "Some chat rooms can be added from its page.";
  if (ensured.boardMissing) {
    return "Its board wasn't set up: open it from the Discussion tab.";
  }
  return null;
}

/** The memo of boards made before their record is saved; one that keeps nothing when storage is refused (a private window). */
function memoStore(): BoardMemoStore {
  try {
    return localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

/** The scope a board made now is remembered under: this community, the founder and the project. */
function boardMemoScope(founder: string, launchId: string): BoardMemoScope {
  return { relay: relayWsUrl(), founder, launchId };
}

/** What the board operations need from the page: where the memo lives, how to check a board and how to make one. */
function boardDeps(scope: BoardMemoScope, launchName: string) {
  return {
    scope,
    store: memoStore(),
    // Read on the server the memo was written for; a failure to answer is thrown, so the memo is kept for a retry.
    isFounders: async (board: string) =>
      boardIsFounders({
        board,
        founder: scope.founder,
        records: await queryEvents(scope.relay, {
          kinds: [KIND_CHANNEL_METADATA, KIND_CHANNEL_ADMINS],
          "#d": [board],
          limit: 10,
        }),
      }),
    make: async () => {
      const made = await createLaunchRooms({
        launchName,
        team: [],
        rooms: ["board"],
      });
      return {
        board: made.created.board ?? null,
        error: made.errors.board ?? null,
      };
    },
  };
}

/**
 * Publish a launch's record with its board, made first (or the one made for it by an earlier, failed try) when the chat
 * has none. A board that cannot be made leaves the chat as it was: the project still starts, and its founder opens the
 * board from the Discussion tab, where the reason is shown. `scope` is taken once by the caller, for the whole run.
 */
export function publishWithProjectBoard(input: {
  scope: BoardMemoScope;
  launchName: string;
  chat: LaunchChat;
  save: (chat: LaunchChat) => Promise<void>;
}): Promise<void> {
  return publishWithBoard({
    ...boardDeps(input.scope, input.launchName),
    chat: input.chat,
    save: input.save,
  });
}

/** How many channels a launch record may name; the server refuses more. */
const MAX_RECORD_CHANNELS = 8;

/**
 * Open the board of a launch that has none (one made before D156), or a new one when the board its record names is
 * gone, then republish the record naming it. The board first, so the record never points at one that does not exist;
 * a failed save keeps the board for the next try. A refusal (the daily limit on new boards) comes back in the
 * server's words. `dropped` counts channels the founder picked that no longer fit beside the board.
 */
export function useCreateProjectBoard(launch: Launch) {
  const save = useCreateLaunch();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ board: string; dropped: number }> => {
      const { record } = launch;
      const deps = boardDeps(
        boardMemoScope(record.author, record.id),
        record.name,
      );
      const { board, error } = await boardForLaunch({
        ...deps,
        avoid: record.chat.board,
      });
      if (!board) {
        throw error ?? new Error("The board wasn't opened. Try again.");
      }
      const chat = { ...record.chat, board };
      const own = new Set(
        [chat.team, chat.supporters, chat.backers, board].filter(Boolean),
      );
      const picked = record.channels.filter(
        (id) => !own.has(id) && id !== record.chat.board,
      );
      const dropped = Math.max(
        0,
        own.size + picked.length - MAX_RECORD_CHANNELS,
      );
      await save.mutateAsync(
        recordToInput(record, {
          chat,
          channels: picked.slice(0, picked.length - dropped),
        }),
      );
      forgetBoardMemo(deps.store, deps.scope, board);
      await queryClient.invalidateQueries({ queryKey: ["channels"] });
      return { board, dropped };
    },
  });
}

function membersKey(channelId: string | null) {
  return ["launchpad", "chat-members", channelId];
}

/** The pubkeys in a room (kind 39002 `p` tags). Empty when it cannot be read. */
function useChannelMembers(channelId: string | null) {
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
