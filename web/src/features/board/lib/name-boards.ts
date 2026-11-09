/**
 * Naming boards in a project's record, from the record as the server has it now.
 *
 * The page holds the record it loaded, which may be old by the time boards are added: the founder may have edited the
 * project in another tab or since the page opened. Saving a whole record from the old copy would put the old copy's
 * values back, so the newest record is read first and the boards are added to that one.
 *
 * Alias-free; `name-boards.test.mjs` drives it under `node --test`.
 */

import { type TiedRecord, tieBoards } from "./project-boards.ts";

export interface NameBoardsDeps<
  R extends Pick<TiedRecord, "channels" | "chat">,
> {
  /** The project's record as the server has it now. Throws when it cannot be read, so nothing is saved from a guess. */
  readLatest: () => Promise<R>;
  /** Save that record with these channels. Throws when the save is refused. */
  save: (record: R, channels: string[]) => Promise<void>;
}

/** Name `ids` in the project's newest record. Resolves with how many channels the founder had picked that no longer fit. */
export async function nameBoardsInRecord<
  R extends Pick<TiedRecord, "channels" | "chat">,
>(
  deps: NameBoardsDeps<R>,
  ids: readonly string[],
  forums: ReadonlySet<string>,
): Promise<number> {
  const latest = await deps.readLatest();
  const { channels, dropped } = tieBoards(
    latest,
    ids.map((id) => id.toLowerCase()),
    forums,
  );
  await deps.save(latest, channels);
  return dropped;
}
