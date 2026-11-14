/**
 * One change at a time to a founder's own project record.
 *
 * Every change to that record is read, merge, publish: read what the server has, change one thing, publish the whole
 * record over it. Two of those running together both read the same record, and the one that publishes last silently
 * undoes the other (a founder presses "Not listed yet" and then "Add to the team": the team save puts the listing
 * back). So changes to one record wait their turn here, whatever part of the page they come from, and each reads the
 * record only when the one before it has finished.
 *
 * A server can also be slow to show a record back. A change that read the record from before this tab's last save
 * would undo that save the same way, so the read is asked again until it shows that save (`readFresh`), and gives up
 * with words when it does not.
 *
 * The turns are kept in a module-level map, by server, founder and project. The web app talks to one server for the
 * life of the page (there is no switching between communities without a reload), and the key names the server anyway,
 * so nothing here can carry one server's turn into another's.
 *
 * Pure and alias-free: `own-record-queue.test.mjs` drives it under `node --test`.
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `run` once every earlier `inTurn` for the same `key` has finished, whether it worked or failed. A failure is
 * the caller's own: it never stops the changes waiting behind it.
 */
export function inTurn<T>(
  key: string,
  run: () => Promise<T>,
  queue: Map<string, Promise<unknown>> = tails,
): Promise<T> {
  const before = queue.get(key) ?? Promise.resolve();
  const mine = before.then(run, run);
  // What waits behind this one must not see its failure as its own.
  const tail = mine.catch(() => undefined);
  queue.set(key, tail);
  void tail.then(() => {
    if (queue.get(key) === tail) queue.delete(key);
  });
  return mine;
}

/** Said when the server keeps answering with the record from before this tab's last save. */
export const RECORD_NOT_SHOWN_YET =
  "The server has not shown your last change to this project yet, so another change can't be made safely. Wait a moment and try again.";

/**
 * The record as the server has it, no older than `atLeast` (when this tab's last save of it was signed). Asked a few
 * times with a pause between; throws {@link RECORD_NOT_SHOWN_YET} when the server still answers with an older one
 * (or with none), so nothing is published over a save it has not shown.
 */
export async function readFresh<R extends { createdAt: number }>(
  read: () => Promise<R | null>,
  atLeast: number | undefined,
  options: {
    tries?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<R | null> {
  const tries = options.tries ?? 6;
  const waitMs = options.waitMs ?? 700;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const record = await read();
    if (atLeast === undefined) return record;
    if (record !== null && record.createdAt >= atLeast) return record;
    if (attempt < tries - 1) await sleep(waitMs);
  }
  throw new Error(RECORD_NOT_SHOWN_YET);
}
