/**
 * Who may be in a launch's chat rooms, as pure functions.
 *
 * Three rooms, three promises:
 * - **team** is private: only the people building it.
 * - **supporters** is open: anyone excited about the project can join with one
 *   click, no money involved.
 * - **backers** is private and gated: it is for people who recorded a bid. A
 *   private room rejects self-join, so the founder admits each backer. The bid
 *   list is advisory (a mirror is a claim, not proof of funds), and the room is
 *   for talking, not for custody.
 */

import type { LaunchBid, LaunchChat } from "../models";

export type RoomKey = "team" | "supporters" | "backers";

/** True when the launch has at least one room to open. */
export function hasChat(chat: LaunchChat): boolean {
  return (
    chat.team !== null || chat.supporters !== null || chat.backers !== null
  );
}

/**
 * The rooms a launch still needs. An idea needs the team and supporters rooms;
 * the backers room only matters once there is a sale to back.
 */
export function missingRooms(
  chat: LaunchChat,
  options: { sale: boolean },
): RoomKey[] {
  const missing: RoomKey[] = [];
  if (!chat.team) missing.push("team");
  if (!chat.supporters) missing.push("supporters");
  if (options.sale && !chat.backers) missing.push("backers");
  return missing;
}

/** The chat with the given rooms filled in; rooms already there are kept. */
export function withRooms(
  chat: LaunchChat,
  rooms: Partial<LaunchChat>,
): LaunchChat {
  return {
    team: chat.team ?? rooms.team ?? null,
    supporters: chat.supporters ?? rooms.supporters ?? null,
    backers: chat.backers ?? rooms.backers ?? null,
  };
}

/**
 * Backers a founder can admit: one entry per bidder, oldest bid first, leaving
 * out the founder, the team and anyone already in the room.
 */
export function pendingBackers(
  bids: readonly Pick<LaunchBid, "author" | "createdAt">[],
  members: ReadonlySet<string>,
  team: readonly string[],
): string[] {
  const skip = new Set([...members, ...team].map((key) => key.toLowerCase()));
  const first = new Map<string, number>();
  for (const bid of bids) {
    const key = bid.author.toLowerCase();
    if (skip.has(key)) continue;
    const seen = first.get(key);
    if (seen === undefined || bid.createdAt < seen)
      first.set(key, bid.createdAt);
  }
  return [...first.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([pubkey]) => pubkey);
}

/** What the viewer can do with one room. */
export type RoomStanding =
  /** In the room already: open it. */
  | "member"
  /** Open room, not in it yet: one click joins. */
  | "join"
  /** Gated room, bid recorded: waiting for the founder. */
  | "pending"
  /** Gated room, no bid: back the launch first. */
  | "locked";

export interface RoomRow {
  room: RoomKey;
  id: string;
  standing: RoomStanding;
}

/**
 * The rooms the viewer should see and what they can do with each.
 *
 * Private rooms are hidden from non-members by the server, so *seeing* one
 * (`visibleRooms`) is the proof of membership. The open supporters room is
 * visible to everyone, so membership comes from its member list instead
 * (`supportersMembers`, null while that list is unknown). The team room is
 * only listed for the team.
 */
export function roomRows(input: {
  chat: LaunchChat;
  visibleRooms: ReadonlySet<string>;
  supportersMembers: ReadonlySet<string> | null;
  viewer: string | null;
  bidders: readonly string[];
}): RoomRow[] {
  const rows: RoomRow[] = [];
  const { chat } = input;
  if (chat.supporters) {
    const viewer = input.viewer?.toLowerCase() ?? null;
    const inside =
      viewer !== null && (input.supportersMembers?.has(viewer) ?? false);
    rows.push({
      room: "supporters",
      id: chat.supporters,
      standing: inside ? "member" : "join",
    });
  }
  if (chat.backers) {
    const viewer = input.viewer?.toLowerCase() ?? null;
    const bid =
      viewer !== null &&
      input.bidders.some((key) => key.toLowerCase() === viewer);
    rows.push({
      room: "backers",
      id: chat.backers,
      standing: input.visibleRooms.has(chat.backers)
        ? "member"
        : bid
          ? "pending"
          : "locked",
    });
  }
  if (chat.team && input.visibleRooms.has(chat.team)) {
    rows.push({ room: "team", id: chat.team, standing: "member" });
  }
  return rows;
}
