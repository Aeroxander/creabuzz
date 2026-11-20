/**
 * Reading and writing a project's holder room (plan sections 4 and 7.6). The room is read with one filter by its tag, and
 * everything it writes carries that tag. What the server refuses stays the server's word: nothing here lets anyone in.
 */
import {
  KIND_EVM_BINDING,
  KIND_LAUNCH_UPDATE,
  KIND_REACTION,
  KIND_TEXT_NOTE,
} from "@creaton/core/kinds.ts";
import {
  buildPost,
  buildReply,
  buildVote,
  type RoomRef,
  roomTagValue,
} from "@creaton/core/social/feed/feed-events.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishAsUser, read, readMulti } from "../../lib/relay";
import type { SignedEvent } from "../posts/use-posts";
import type { Project } from "../project/project-record";
import { chainKeyOfProject } from "../money/use-money";
import {
  activeMutes,
  linkedAddresses,
  MUTE_DAYS_MAX,
  muteRecord,
  type RoomMute,
  removeRecord,
  reportRecord,
} from "./room-records";
import type { ReportChoice } from "./room-words";

/** The most posts and likes one read of the room takes. */
const NOTES_READ = 200;
const LIKES_READ = 500;
/** The most stops on people the room's team has signed that are read. */
const MUTES_READ = 200;

const roomKeys = {
  all: ["room"] as const,
  read: (coordinate: string, key: string) =>
    ["room", "read", coordinate, key] as const,
  newest: (coordinate: string, key: string) =>
    ["room", "newest", coordinate, key] as const,
  mutes: (coordinate: string) => ["room", "mutes", coordinate] as const,
};

/** The room of a project: its coordinate and the chain key its record names, or null for a project not on the network. */
export function roomOf(project: Project): RoomRef | null {
  const key = chainKeyOfProject(project);
  if (!key || !/^0x[0-9a-f]{64}$/.test(key)) return null;
  return { launch: { pubkey: project.author, id: project.id }, key };
}

/** The room's posts (kind 1) and likes (kind 7), by its tag only. */
export function useRoomEvents(room: RoomRef | null, coordinate: string) {
  return useQuery({
    queryKey: roomKeys.read(coordinate, room?.key ?? ""),
    enabled: room !== null,
    staleTime: 10_000,
    queryFn: async () => {
      if (!room) return { notes: [], likes: [] };
      const tag = { "#a": [coordinate], "#t": [roomTagValue(room.key)] };
      const [notes, likes] = await readMulti([
        { kinds: [KIND_TEXT_NOTE], ...tag, limit: NOTES_READ },
        { kinds: [KIND_REACTION], ...tag, limit: LIKES_READ },
      ]);
      return { notes: notes as SignedEvent[], likes: likes as SignedEvent[] };
    },
  });
}

/** The time of the newest post in the room (one small read), or 0: what the "New" dot on the tab is made from. */
export function useRoomNewest(room: RoomRef | null, coordinate: string) {
  return useQuery({
    queryKey: roomKeys.newest(coordinate, room?.key ?? ""),
    enabled: room !== null,
    staleTime: 60_000,
    queryFn: async () => {
      if (!room) return 0;
      const posts = await read({
        kinds: [KIND_TEXT_NOTE],
        "#a": [coordinate],
        "#t": [roomTagValue(room.key)],
        limit: 1,
      });
      return posts.reduce((newest, e) => Math.max(newest, e.created_at), 0);
    },
  });
}

/** The team's stops that are in force now: records signed by the team only. */
export function useRoomMutes(
  coordinate: string,
  team: readonly string[],
  enabled: boolean,
) {
  return useQuery({
    queryKey: roomKeys.mutes(coordinate),
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<RoomMute[]> => {
      const events = await read({
        kinds: [KIND_LAUNCH_UPDATE],
        "#a": [coordinate],
        limit: MUTES_READ,
      });
      return activeMutes(
        events.filter((e) => e.tags.some((t) => t[0] === "room-mute")),
        new Set(team),
        Math.floor(Date.now() / 1000),
      );
    },
  });
}

/** What a write in the room changes: the room is read again. */
function useAfterWrite() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: roomKeys.all });
}

/** Write a post in the room. A refusal throws the server's own words, for the composer to say in plain words. */
export function useRoomPost(room: RoomRef | null) {
  const after = useAfterWrite();
  return useMutation({
    mutationFn: (input: { text: string }) => {
      if (!room) throw new Error("This project has no room yet.");
      return publishAsUser(
        buildPost({ text: input.text, room }),
        "Your post was not sent. Try again.",
      );
    },
    onSuccess: after,
  });
}

/** Answer a post of the room, in the room. */
export function useRoomReply(room: RoomRef | null) {
  const after = useAfterWrite();
  return useMutation({
    mutationFn: (input: {
      text: string;
      root: SignedEvent;
      parent: SignedEvent;
    }) => {
      if (!room) throw new Error("This project has no room yet.");
      return publishAsUser(
        buildReply({ ...input, room }),
        "Your reply was not sent. Try again.",
      );
    },
    onSuccess: after,
  });
}

/** Like a post of the room. */
export function useRoomLike(room: RoomRef | null) {
  const after = useAfterWrite();
  return useMutation({
    mutationFn: (target: SignedEvent) => {
      if (!room) throw new Error("This project has no room yet.");
      return publishAsUser(
        buildVote({ target, direction: "+", room }),
        "Your like was not sent. Try again.",
      );
    },
    onSettled: after,
  });
}

/** Tell the people who run the server about a post. */
export function useReportPost() {
  return useMutation({
    mutationFn: (input: { post: SignedEvent; type: ReportChoice }) =>
      publishAsUser(
        reportRecord(input.post, input.type),
        "The report was not sent. Try again.",
      ),
  });
}

/** The team takes a post out of its room, with a reason everyone can read. */
export function useRemovePost() {
  const after = useAfterWrite();
  return useMutation({
    mutationFn: (input: { postId: string; reason: string }) =>
      publishAsUser(
        removeRecord(input.postId, input.reason),
        "The post was not removed. Try again.",
      ),
    onSuccess: after,
  });
}

/**
 * The team stops a person writing in the room for `days` days (0 lifts a stop), naming the wallets that person has linked, which
 * are read now from their own link records.
 */
export function useStopWriting(coordinate: string) {
  const after = useAfterWrite();
  return useMutation({
    mutationFn: async (input: { person: string; days: number }) => {
      const records = await read({
        kinds: [KIND_EVM_BINDING],
        authors: [input.person],
        limit: 20,
      });
      const days = Math.min(Math.max(input.days, 0), MUTE_DAYS_MAX);
      const now = Math.floor(Date.now() / 1000);
      return publishAsUser(
        muteRecord({
          coordinate,
          person: input.person,
          wallets: linkedAddresses(records as SignedEvent[], input.person),
          // A stop that already ended is how one is lifted; a few minutes short of the longest, so a clock a little ahead of the server's is not refused.
          until: days === 0 ? now - 1 : now + days * 86_400 - 300,
        }),
        "That was not saved. Try again.",
      );
    },
    onSuccess: after,
  });
}
