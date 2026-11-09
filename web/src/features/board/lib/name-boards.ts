/**
 * Naming boards in a project's record, from the record as the server has it now.
 *
 * The page holds the record it loaded, which may be old by the time boards are added: the founder may have edited the
 * project in another tab or since the page opened. Saving a whole record from the old copy would put the old copy's
 * values back, so the newest record is read first and the boards are added to that one.
 *
 * A record names a limited number of channels. When it is full, boards are kept before other links, so which of its
 * channels are boards is read too, by their ids.
 *
 * Alias-free; `name-boards.test.mjs` drives it under `node --test`.
 */

import { type TiedRecord, tieBoards } from "./project-boards.ts";

export interface NameBoardsDeps<
  R extends Pick<TiedRecord, "channels" | "chat">,
> {
  /** The project's record as the server has it now. Throws when it cannot be read, so nothing is saved from a guess. */
  readLatest: () => Promise<R>;
  /**
   * Which of these channels (lower-case ids) are boards, each read by its id. Throws when they cannot be read, so the
   * links to keep are never chosen from a list that may be missing a board.
   */
  boardsAmong: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Save that record with these channels. Throws when the save is refused. */
  save: (record: R, channels: string[]) => Promise<void>;
}

/** Name `ids` in the project's newest record. Resolves with how many channels the founder had picked that no longer fit. */
export async function nameBoardsInRecord<
  R extends Pick<TiedRecord, "channels" | "chat">,
>(deps: NameBoardsDeps<R>, ids: readonly string[]): Promise<number> {
  const latest = await deps.readLatest();
  // Asked about the channels this record names, not looked up in a page of the server's channel list: an older board
  // is not on that page, and would be dropped before a chat room when the record is full.
  const forums = await deps.boardsAmong(
    latest.channels.map((id) => id.toLowerCase()),
  );
  const { channels, dropped } = tieBoards(
    latest,
    ids.map((id) => id.toLowerCase()),
    forums,
  );
  await deps.save(latest, channels);
  return dropped;
}
