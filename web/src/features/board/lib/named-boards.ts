/**
 * Reading the boards a project's record names, by their ids.
 *
 * The server's list of channels comes a page at a time, newest first, and counts direct-message threads too. A board
 * older than the first page is not in it, so looking a project's boards up in that page loses them on a busy server:
 * the project then reads as having no boards. A record already says which channels it names, so they are asked for by
 * id instead, in pieces the server accepts and a few at a time. One failed piece fails the whole read: a project's
 * boards are never worked out from part of an answer.
 *
 * Alias-free; `named-boards.test.mjs` drives it under `node --test`.
 */

import {
  type Channel,
  type ChannelRecord,
  channelsFromRecords,
} from "../../channels/lib/channel-records.ts";

export const KIND_CHANNEL_METADATA = 39000;

/** The server refuses a read that names more records than this. */
export const NAMED_READ_CHUNK = 100;
/** How many pieces are asked for at once: each is a connection of its own. */
const NAMED_READ_AT_ONCE = 4;

/** One read of the server: the records that match, or a throw when it does not answer or refuses. */
export type ReadRecords<R> = (filter: {
  kinds: number[];
  "#d": string[];
  limit: number;
}) => Promise<R[]>;

/**
 * The server's records of one kind for these ids (their `d`), asked in pieces of at most `NAMED_READ_CHUNK` ids,
 * `NAMED_READ_AT_ONCE` pieces at a time. Rejects with the first failure, whatever the other pieces answered.
 */
export async function readRecordsNaming<R>(
  read: ReadRecords<R>,
  kind: number,
  ids: readonly string[],
): Promise<R[]> {
  const wanted = [...new Set(ids)].sort();
  const pieces: string[][] = [];
  for (let i = 0; i < wanted.length; i += NAMED_READ_CHUNK)
    pieces.push(wanted.slice(i, i + NAMED_READ_CHUNK));
  const records: R[] = [];
  for (let i = 0; i < pieces.length; i += NAMED_READ_AT_ONCE) {
    const answers = await Promise.all(
      pieces.slice(i, i + NAMED_READ_AT_ONCE).map((piece) =>
        read({
          kinds: [kind],
          "#d": piece,
          // Room for a record the server has twice (a renamed board's old and new record).
          limit: piece.length * 2,
        }),
      ),
    );
    records.push(...answers.flat());
  }
  return records;
}

/**
 * The boards among the channels named by `ids` (lower case, as `boardProject` gives them): each one's own record,
 * whichever page of the channel list it would be on. Chat rooms and direct-message threads the ids name are left out,
 * and so is anything the server sends that was not asked for.
 */
export async function readNamedBoards(
  read: ReadRecords<ChannelRecord>,
  ids: readonly string[],
): Promise<Channel[]> {
  const asked = new Set(ids);
  const records = await readRecordsNaming(read, KIND_CHANNEL_METADATA, ids);
  return channelsFromRecords(records).filter(
    (channel) =>
      channel.type === "forum" &&
      !channel.direct &&
      asked.has(channel.id.toLowerCase()),
  );
}

/**
 * The boards a decision of a project can be talked about on: the boards among the channels the server listed (its
 * first page, which is where the server's own boards are found) and the project's own, read by id, which may be older
 * than that page. One per board, by name.
 */
export function discussionBoards(
  listed: readonly Channel[],
  named: readonly Channel[],
): Channel[] {
  const byId = new Map<string, Channel>();
  for (const channel of [...listed, ...named]) {
    if (channel.type !== "forum" || channel.direct) continue;
    const key = channel.id.toLowerCase();
    const known = byId.get(key);
    if (!known || channel.createdAt > known.createdAt) byId.set(key, channel);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The boards a project is known to have: null while they are still being read or when the read failed. An empty list
 * only ever means the read succeeded and found none, which is what offering to make a project's first boards has to
 * rest on.
 */
export function knownBoards<T>(read: {
  boards: readonly T[];
  loading: boolean;
  error: unknown;
}): readonly T[] | null {
  return read.loading || read.error != null ? null : read.boards;
}
