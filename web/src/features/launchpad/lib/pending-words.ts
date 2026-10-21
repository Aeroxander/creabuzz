/**
 * Work areas' words still to be published (Review-Proven Rule 1). The chain keeps only the hash of a work area's words,
 * so when the vote that approves one opens, its words are published beside it (`workAreaUpdateContent`). If that
 * publish fails, the words would otherwise live only in the form, which closes and resets once the vote is open: a
 * reload would lose them, and newcomers could never read what finished work looks like.
 *
 * So the job is written to this browser's storage before the form lets go of it, scoped to the server, the network,
 * the project and the account that opened the vote, and removed only once the server accepted the words. A retry
 * publishes the words alone; it never opens the vote again.
 *
 * Pure apart from the injected storage; alias-free so `pending-words.test.mjs` drives it under `node --test`.
 */

/** The storage it uses: `localStorage`, or a stand-in. Every access may throw (private mode, blocked storage). */
export interface WordsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PENDING_WORDS_KEY = "buzz.launchpad.pendingWorkAreaWords";
/** The most jobs kept: a person opens few votes, and a stuck list must not grow without end. */
export const MAX_PENDING_WORDS = 50;

export interface PendingWords {
  /** Which server, network, project and account it belongs to (`pendingScope`). */
  scope: string;
  mandate: string;
  id: string;
  check: string;
  createdAt: number;
}

export function pendingScope(input: {
  relay: string;
  chainId: string | number | null;
  author: string;
  launchId: string;
  account: string;
}): string {
  return [
    input.relay,
    String(input.chainId ?? ""),
    `${input.author}:${input.launchId}`,
    input.account,
  ]
    .map((part) => part.toLowerCase())
    .join("|");
}

function readAll(storage: WordsStorage): PendingWords[] {
  try {
    const raw = storage.getItem(PENDING_WORDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PendingWords =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.scope === "string" &&
        typeof entry.mandate === "string" &&
        typeof entry.id === "string" &&
        typeof entry.check === "string" &&
        typeof entry.createdAt === "number",
    );
  } catch {
    return [];
  }
}

function writeAll(storage: WordsStorage, jobs: PendingWords[]): boolean {
  try {
    storage.setItem(
      PENDING_WORDS_KEY,
      JSON.stringify(jobs.slice(-MAX_PENDING_WORDS)),
    );
    return true;
  } catch {
    return false;
  }
}

const sameJob = (
  a: PendingWords,
  b: Omit<PendingWords, "check" | "createdAt">,
) =>
  a.scope === b.scope &&
  a.mandate.toLowerCase() === b.mandate.toLowerCase() &&
  a.id.toLowerCase() === b.id.toLowerCase();

/** The jobs waiting in one scope, oldest first. */
export function pendingIn(
  storage: WordsStorage,
  scope: string,
): PendingWords[] {
  return readAll(storage).filter((job) => job.scope === scope);
}

/** Keep a job until its words are published; the newest words for one work area replace older ones. False if not kept. */
export function keepPending(storage: WordsStorage, job: PendingWords): boolean {
  return writeAll(storage, [
    ...readAll(storage).filter((other) => !sameJob(other, job)),
    job,
  ]);
}

/** The words were accepted: forget the job. */
export function dropPending(
  storage: WordsStorage,
  job: Omit<PendingWords, "check" | "createdAt">,
): void {
  writeAll(
    storage,
    readAll(storage).filter((other) => !sameJob(other, job)),
  );
}
