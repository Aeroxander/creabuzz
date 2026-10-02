/**
 * Who may be in a launch's chat rooms, as pure functions.
 *
 * Private rooms reject self-join, so a backer is admitted by a founder. The
 * founder's list of people to admit is "everyone with a recorded bid who is
 * not already in the supporters room" — advisory, like the bid mirrors it
 * comes from (a bid mirror is a claim, not proof of funds; the room is for
 * talking, not for custody).
 */

import type { LaunchBid, LaunchChat } from "../models";

/** What the viewer can do with a launch's chat, most capable first. */
export type ChatAccess =
  /** In at least one of the rooms already. */
  | "member"
  /** Recorded a bid but has not been admitted yet. */
  | "pending"
  /** Neither: back the launch first. */
  | "none";

/** True when the launch has at least one room to open. */
export function hasChat(chat: LaunchChat): boolean {
  return chat.team !== null || chat.supporters !== null;
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

/**
 * The viewer's standing. `visibleRooms` are the room ids the viewer's relay
 * session can see at all: private rooms are hidden from non-members, so
 * seeing one is the proof of membership.
 */
export function chatAccess(input: {
  chat: LaunchChat;
  visibleRooms: ReadonlySet<string>;
  viewer: string | null;
  bidders: readonly string[];
}): ChatAccess {
  const rooms = [input.chat.team, input.chat.supporters].filter(
    (id): id is string => id !== null,
  );
  if (rooms.some((id) => input.visibleRooms.has(id))) return "member";
  if (
    input.viewer !== null &&
    input.bidders.some(
      (key) => key.toLowerCase() === input.viewer?.toLowerCase(),
    )
  ) {
    return "pending";
  }
  return "none";
}

/** The room a viewer lands in: the team room for the team, else the supporters room. */
export function roomToOpen(
  chat: LaunchChat,
  visibleRooms: ReadonlySet<string>,
): string | null {
  if (chat.supporters && visibleRooms.has(chat.supporters))
    return chat.supporters;
  if (chat.team && visibleRooms.has(chat.team)) return chat.team;
  return null;
}
