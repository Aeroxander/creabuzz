/**
 * Reading the boards of a server for a list of them (Home's Boards tab), a bounded step at a time.
 *
 * The server keeps one record per channel and pages them newest first. It cannot be asked for the boards alone: a
 * `#t` filter is only applied to the page it has already cut (`buzz-relay` matches it after the read's limit), so a
 * read for "forum" records would come back short, or empty, with older boards still behind it. The channel records are
 * therefore walked as they are, rooms and direct-message threads included, and the boards picked out here.
 *
 * A step reads at most `BOARD_PAGES_PER_STEP` pages and then stops, saying where the next one starts: a busy server is
 * never read without limit, and the page offers the next step to the reader instead. A page that fails after others in
 * the same step were read keeps what was read and says so; it is never passed off as the end of the list.
 *
 * Alias-free; `board-pages.test.mjs` drives it under `node --test`.
 */

import {
  type Channel,
  type ChannelRecord,
  channelsFromRecords,
  mergeChannelPages,
} from "../../channels/lib/channel-records.ts";
import { KIND_CHANNEL_METADATA } from "./named-boards.ts";

/** Channel records asked for in one read. */
export const BOARD_PAGE_SIZE = 200;
/** Reads in one step: the most channel records looked through before the reader is asked whether to go on. */
export const BOARD_PAGES_PER_STEP = 5;

/** One read of the server's channel records, newest first, at or before `until` when given. Throws when it fails. */
export type ReadChannelPage<R> = (filter: {
  kinds: number[];
  limit: number;
  until?: number;
}) => Promise<R[]>;

export interface BoardStep {
  /** The boards found in this step. */
  boards: Channel[];
  /** Where the next step starts (the `until` of its first read); null when the server has nothing older. */
  next: number | null;
  /** Why the step stopped early, when one of its later reads failed; null when every read was answered. */
  failed: unknown;
}

function boardsIn(records: readonly ChannelRecord[]): Channel[] {
  return channelsFromRecords(records).filter(
    (channel) => channel.type === "forum" && !channel.direct,
  );
}

/**
 * One step back through the channel records from `from` (the newest, when undefined). Rejects when its first read
 * fails: nothing was read, so there is nothing to keep. A later read that fails ends the step with what the earlier
 * ones found, `failed` set and `next` at the read to try again.
 */
export async function readBoardStep<R extends ChannelRecord>(
  read: ReadChannelPage<R>,
  from: number | undefined,
  pages: number = BOARD_PAGES_PER_STEP,
): Promise<BoardStep> {
  let until = from;
  let boards: Channel[] = [];
  for (let page = 0; page < pages; page++) {
    let records: R[];
    try {
      records = await read({
        kinds: [KIND_CHANNEL_METADATA],
        limit: BOARD_PAGE_SIZE,
        ...(until === undefined ? {} : { until }),
      });
    } catch (error) {
      if (until === undefined || page === 0) throw error;
      return { boards, next: until, failed: error };
    }
    boards = mergeChannelPages(boards, boardsIn(records));
    // A short page is the last one: the server had no more to send.
    if (records.length < BOARD_PAGE_SIZE)
      return { boards, next: null, failed: null };
    const times = records.map((record) => record.created_at);
    const oldest = Math.min(...times);
    // `until` is inclusive, so the next read starts at the oldest second read and records sharing it are not skipped
    // (repeats are merged by id). Only a page that is all one second has to step past it to move at all, which also
    // makes every read start strictly earlier than the one before: the walk cannot go round in place.
    until = times.every((time) => time === oldest) ? oldest - 1 : oldest;
  }
  return { boards, next: until ?? null, failed: null };
}

/** The boards of every step read so far, one per board (its newest record), by name. */
export function boardsOfSteps(steps: readonly BoardStep[]): Channel[] {
  return steps
    .reduce<Channel[]>((all, step) => mergeChannelPages(all, step.boards), [])
    .sort((a, b) => a.name.localeCompare(b.name));
}
