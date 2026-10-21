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
 * Nothing unpublished is ever dropped to make room: the list is bounded, and a full list refuses a new job (and says
 * so) rather than evicting an older one. Each job carries a revision, and only the publish of that exact revision
 * removes it, so a slower publish of older words can never remove newer words that replaced them.
 *
 * Pure apart from the injected storage; alias-free so `pending-words.test.mjs` drives it under `node --test`.
 */

/** The storage it uses: `localStorage`, or a stand-in. Every access may throw (private mode, blocked storage). */
export interface WordsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PENDING_WORDS_KEY = "buzz.launchpad.pendingWorkAreaWords";
/** The most jobs kept: a person opens few votes, and a stuck list must not grow without end. A full list refuses. */
export const MAX_PENDING_WORDS = 50;

export interface PendingWords {
  /** Which server, network, project and account it belongs to (`pendingScope`). */
  scope: string;
  mandate: string;
  id: string;
  check: string;
  createdAt: number;
  /** This payload's own token: a publish removes the job only when it published this revision. */
  revision: string;
}

/** Whether a job was kept: `full` when the list is at its bound (nothing was evicted), `unavailable` when storage refused. */
export type KeepResult = "kept" | "full" | "unavailable";

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
        typeof entry.createdAt === "number" &&
        typeof entry.revision === "string",
    );
  } catch {
    return [];
  }
}

/** Write the whole list, or nothing: a refused write leaves every job that was there. */
function writeAll(storage: WordsStorage, jobs: PendingWords[]): boolean {
  try {
    storage.setItem(PENDING_WORDS_KEY, JSON.stringify(jobs));
    return true;
  } catch {
    return false;
  }
}

/** The same work area in the same scope (whatever its words or revision). */
const sameArea = (
  a: Pick<PendingWords, "scope" | "mandate" | "id">,
  b: Pick<PendingWords, "scope" | "mandate" | "id">,
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

/** Whether the list is at its bound, across every scope: a new job would be refused. */
export function pendingFull(storage: WordsStorage): boolean {
  return readAll(storage).length >= MAX_PENDING_WORDS;
}

/**
 * Keep a job until its words are published. Newer words for a work area already waiting replace its older words (and
 * their revision); a new work area is refused when the list is full, and nothing waiting is evicted to make room.
 */
export function keepPending(
  storage: WordsStorage,
  job: PendingWords,
): KeepResult {
  const all = readAll(storage);
  const replacing = all.some((other) => sameArea(other, job));
  if (!replacing && all.length >= MAX_PENDING_WORDS) return "full";
  return writeAll(storage, [
    ...all.filter((other) => !sameArea(other, job)),
    job,
  ])
    ? "kept"
    : "unavailable";
}

/** These words, this revision, were accepted: forget the job, unless newer words have replaced it since. */
export function dropPending(
  storage: WordsStorage,
  job: Pick<PendingWords, "scope" | "mandate" | "id" | "revision">,
): void {
  const all = readAll(storage);
  const kept = all.filter(
    (other) => !(sameArea(other, job) && other.revision === job.revision),
  );
  if (kept.length !== all.length) writeAll(storage, kept);
}
