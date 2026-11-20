/**
 * What a person is owed from tasks (plan section 5.9): which tasks to look at, and what the network says about each. The
 * signed record is a hint for the list; the figure on a button and in a sheet is always read from the network for the
 * connected account, because a leaver holds no Shares and is not in the record's list of holders.
 */
import {
  type ChainTaskNow,
  readBookOf,
  readNoteOf,
  readTask,
} from "@creaton/core/pot/pot-reads.ts";
import type { Ready } from "../../../pot/use-pot";
import type { ChainTasks } from "../types";

/** The most tasks one list reads (and the most candidates there can be). */
export const MOST_CANDIDATES = 40;

/** How many tasks are read at the same time: a bound on a burst of calls to a node. */
const AT_ONCE = 10;

/**
 * The tasks this account may hold money owed on, newest first, at most 40: the record's rows that list the account among
 * the holders of notes, every ended row with money still to claim, every taken row (a note on a running task), plus what this
 * browser remembers and what a look back found. A guess that is wrong costs one read: the network says it holds nothing.
 */
export function noteCandidates(input: {
  queue: ChainTasks | null;
  account: string;
  own: readonly bigint[];
  found: readonly bigint[];
}): bigint[] {
  const me = input.account.toLowerCase();
  const serials = new Set<bigint>([...input.own, ...input.found]);
  for (const row of input.queue?.list ?? []) {
    const open = row.state === "announced" || row.state === "taken";
    const listed = row.notes?.holders.some((h) => h.account === me) ?? false;
    if (listed || row.state === "taken" || (!open && row.notesLeft > 0n))
      serials.add(row.serial);
  }
  return [...serials]
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, MOST_CANDIDATES);
}

/** A task the account holds a claim on, as the network says it now. */
export interface NoteNow {
  serial: bigint;
  /** What the account is owed against the task, before the task's result (the face of the note). */
  face: bigint;
  task: ChainTaskNow;
}

/** What the list reads. */
export interface NotesRead {
  book: string;
  /** The network's clock; the caller lifts it to the record's. */
  time: number;
  notes: NoteNow[];
}

/**
 * Reads `noteOf` and `taskOf` for each serial, ten at a time. A task the account holds nothing on, or that does not exist,
 * is left out. Any read that fails throws: a list is never made from a read that failed ("none" is never said for that).
 */
export async function readNotes(
  ready: Ready,
  treasury: string,
  serials: readonly bigint[],
  fallbackNow: number,
): Promise<NotesRead> {
  const book = await readBookOf(ready.read, treasury);
  if (book === null)
    throw new Error("This project has no place to keep tasks on the network.");
  const time = ready.wallet.blockTime
    ? await ready.wallet.blockTime("latest").catch(() => fallbackNow)
    : fallbackNow;
  const notes: NoteNow[] = [];
  for (let at = 0; at < serials.length; at += AT_ONCE) {
    const chunk = serials.slice(at, at + AT_ONCE);
    const read = await Promise.all(
      chunk.map(async (serial) => {
        const [face, task] = await Promise.all([
          readNoteOf(ready.read, book, serial, ready.address),
          readTask(ready.read, book, serial),
        ]);
        return { serial, face, task };
      }),
    );
    for (const item of read)
      if (item.face > 0n && item.task !== null)
        notes.push({ serial: item.serial, face: item.face, task: item.task });
  }
  return { book, time, notes };
}
