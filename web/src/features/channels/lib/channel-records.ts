/**
 * Channels as the server describes them: one metadata record per channel, read into the rooms people see listed.
 *
 * A direct-message thread has a metadata record too (the server marks it as a DM and as hidden). It belongs in Messages,
 * never in a list of rooms, so `listedRooms` leaves it out; paging still walks every record, DMs included, because the
 * server pages by record and not by room.
 *
 * Alias-free; `channel-records.test.mjs` drives it under `node --test`.
 */

import { isDmChannelMetadata } from "@creaton/core/dm.ts";

/** A NIP-29 channel resolved from its kind:39000 metadata event. */
export interface Channel {
  /** Channel uuid (the `d` tag / h-tag used by timeline filters). */
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  /**
   * What the channel is for: live chat (`stream`) or a board of posts and
   * replies (`forum`, the server's name for it). The server tags it `t` on the
   * channel's metadata record.
   */
  type: "stream" | "forum";
  /** A direct-message thread (the server tags its metadata `t=dm`, or only `hidden`), not a room anyone is added to. */
  direct: boolean;
  /** Metadata timestamp, used as the cursor when walking older pages. */
  createdAt: number;
  /** Who signed the metadata: the server's key, which also signs the room's notes (`null` when not known). */
  serverKey: string | null;
}

/** The fields of a metadata record this module reads. */
export interface ChannelRecord {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
}

function tagValue(record: ChannelRecord, name: string): string | undefined {
  return record.tags.find((tag) => tag[0] === name)?.[1];
}

/** Deduplicate addressable events, keeping the latest per (pubkey, kind, d). */
export function latestRecords<T extends ChannelRecord>(
  records: readonly T[],
): T[] {
  const best = new Map<string, T>();
  for (const record of records) {
    const key = `${record.pubkey}:${record.kind}:${tagValue(record, "d") ?? ""}`;
    const previous = best.get(key);
    if (!previous || record.created_at > previous.created_at) {
      best.set(key, record);
    }
  }
  return [...best.values()];
}

export function channelFromRecord(record: ChannelRecord): Channel {
  const id = tagValue(record, "d") ?? record.id;
  return {
    id,
    name: tagValue(record, "name") || id.slice(0, 8),
    description: tagValue(record, "about") ?? "",
    visibility: record.tags.some((tag) => tag[0] === "private")
      ? "private"
      : "public",
    type: record.tags.some((tag) => tag[0] === "t" && tag[1] === "forum")
      ? "forum"
      : "stream",
    direct: isDmChannelMetadata(record),
    createdAt: record.created_at,
    serverKey: record.pubkey,
  };
}

/** Every channel in one page of metadata records, DM threads included, sorted by name. */
export function channelsFromRecords(
  records: readonly ChannelRecord[],
): Channel[] {
  return latestRecords(records)
    .map(channelFromRecord)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The rooms to list: every channel except direct-message threads, which Messages shows. */
export function listedRooms(channels: readonly Channel[]): Channel[] {
  return channels.filter((channel) => !channel.direct);
}

/**
 * The room a community opens on when the link names none: #general when there is one, else its first chat room, else
 * its first board. Null for a community with no rooms, which then offers to set itself up.
 */
export function defaultRoom(channels: readonly Channel[]): Channel | null {
  const rooms = channels.filter((channel) => !channel.direct);
  return (
    rooms.find(
      (room) => room.type === "stream" && room.name.toLowerCase() === "general",
    ) ??
    rooms.find((room) => room.type === "stream") ??
    rooms[0] ??
    null
  );
}
