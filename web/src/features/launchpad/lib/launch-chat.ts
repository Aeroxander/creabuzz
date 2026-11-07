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

/** The most `buzz-channel` tags the server takes on a launch record. */
const MAX_BOUND_CHANNELS = 8;

/**
 * Every channel a launch record binds, once each: the launch's own rooms and board first, so they always fit under the
 * server's cap, then the channels the founder picked while there is room.
 */
export function boundChannelIds(input: {
  channels: readonly string[];
  chat?: LaunchChat;
}): string[] {
  const own = [
    input.chat?.team,
    input.chat?.supporters,
    input.chat?.backers,
    input.chat?.board,
  ].filter((id): id is string => Boolean(id));
  return [...new Set([...own, ...input.channels])].slice(0, MAX_BOUND_CHANNELS);
}

/** True when the launch has at least one chat room to open (the board is not a chat room). */
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
    board: chat.board ?? rooms.board ?? null,
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
type RoomStanding =
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

// ---- remembering a board made before its record is saved ------------------------------------------------------------

/**
 * Whose board a remembered board is: the community (its server's address), the founder (the record's author) and the
 * project. Project ids are unique only per founder and per community, so a memo keyed by the id alone handed one
 * founder's board to another who picked the same name in the same browser. Taken once per operation, so a step that
 * runs after a community switch still reads the memo it wrote.
 */
export interface BoardMemoScope {
  relay: string;
  founder: string;
  launchId: string;
}

/** The part of `localStorage` the memo uses. */
export interface BoardMemoStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A server address as one spelling: lower-case, no trailing slash. */
function relayKey(relay: string): string {
  return relay.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Where the board is remembered. An older memo keyed by the project id alone (`creaton:launch-board:<id>`) is never
 * read: it says nothing about whose board it was.
 */
export function boardMemoKey(scope: BoardMemoScope): string {
  return `creaton:launch-board:v2:${encodeURIComponent(relayKey(scope.relay))}:${scope.founder.toLowerCase()}:${scope.launchId}`;
}

function readBoardMemo(
  store: BoardMemoStore,
  scope: BoardMemoScope,
): string | null {
  try {
    return store.getItem(boardMemoKey(scope));
  } catch {
    return null;
  }
}

function writeBoardMemo(
  store: BoardMemoStore,
  scope: BoardMemoScope,
  board: string,
): void {
  try {
    store.setItem(boardMemoKey(scope), board);
  } catch {
    // Private mode: a retry may make a second board, which the founder can remove.
  }
}

/**
 * Forget the remembered board once a record names it. Only when the memo still holds that board: another tab may have
 * remembered a different one since, and that one still needs its record.
 */
export function forgetBoardMemo(
  store: BoardMemoStore,
  scope: BoardMemoScope,
  board: string,
): void {
  try {
    if (store.getItem(boardMemoKey(scope)) === board) {
      store.removeItem(boardMemoKey(scope));
    }
  } catch {
    // Nothing was kept.
  }
}

/** The fields of a board's server records (kinds 39000 and 39001) this check reads. */
export interface BoardRecord {
  kind: number;
  created_at: number;
  tags: string[][];
}

/**
 * Whether a remembered board may be taken as the founder's: the server describes it as a board (its newest metadata is
 * tagged `t=forum`) and lists the founder among its owners or admins (its newest admins record). Anything else (no
 * record, a chat room, someone else's board) is not adopted.
 */
export function boardIsFounders(input: {
  board: string;
  founder: string;
  records: readonly BoardRecord[];
}): boolean {
  const newest = (kind: number) =>
    input.records
      .filter(
        (record) =>
          record.kind === kind &&
          record.tags.some((tag) => tag[0] === "d" && tag[1] === input.board),
      )
      .reduce<BoardRecord | null>(
        (best, record) =>
          best === null || record.created_at > best.created_at ? record : best,
        null,
      );
  const metadata = newest(39000);
  const admins = newest(39001);
  if (!metadata || !admins) return false;
  const forum = metadata.tags.some(
    (tag) => tag[0] === "t" && tag[1] === "forum",
  );
  const founder = input.founder.toLowerCase();
  const runsIt = admins.tags.some(
    (tag) =>
      tag[0] === "p" &&
      tag[1]?.toLowerCase() === founder &&
      (tag[2] === "owner" || tag[2] === "admin"),
  );
  return forum && runsIt;
}

/**
 * A board for the launch, made now unless one was already made for it and not yet recorded: a start that publishes its
 * record more than once (a contributor project retried after a failed step), or an Open the project board whose record
 * save failed, reuses the board made the first time instead of leaving another behind. `avoid` is a board that must
 * not be reused (the record names it, and it is gone). A remembered board is adopted only when `isFounders` confirms it
 * on the server; when it does not, it is forgotten and a new one is made. When the check itself fails (the server did
 * not answer), the error is thrown and the memo kept, so a retry can still reuse the board instead of making a second.
 * Returns the board, or null and the server's reason.
 */
export async function boardForLaunch(input: {
  scope: BoardMemoScope;
  avoid?: string | null;
  store: BoardMemoStore;
  isFounders: (board: string) => Promise<boolean>;
  make: () => Promise<{ board: string | null; error: unknown }>;
}): Promise<{ board: string | null; error: unknown }> {
  const remembered = readBoardMemo(input.store, input.scope);
  if (remembered && remembered !== input.avoid) {
    if (await input.isFounders(remembered)) {
      return { board: remembered, error: null };
    }
    forgetBoardMemo(input.store, input.scope, remembered);
  }
  const made = await input.make();
  if (made.board) writeBoardMemo(input.store, input.scope, made.board);
  return made;
}

/**
 * Publish a launch's record with its board, made (or reused) first if the chat has none, so the record never names a
 * board that does not exist. A board that cannot be made leaves the chat as it was: the project still starts, and its
 * founder opens the board from the Discussion tab. The memo is forgotten only after `save` resolves, so a refused
 * record keeps the board for the next try.
 */
export async function publishWithBoard(input: {
  scope: BoardMemoScope;
  chat: LaunchChat;
  store: BoardMemoStore;
  isFounders: (board: string) => Promise<boolean>;
  make: () => Promise<{ board: string | null; error: unknown }>;
  save: (chat: LaunchChat) => Promise<void>;
}): Promise<void> {
  if (input.chat.board) {
    await input.save(input.chat);
    return;
  }
  const { board } = await boardForLaunch(input);
  await input.save(board ? withRooms(input.chat, { board }) : input.chat);
  if (board) forgetBoardMemo(input.store, input.scope, board);
}
