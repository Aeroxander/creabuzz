/**
 * Making a project's supporters and founders boards: each board's creation and first post, then one save of the
 * project's record naming the boards that were made.
 *
 * The record is what makes a board the project's, so a board made but not yet named would sit on the server with no
 * project. Each board's id, and whether its first post is sent, is remembered (in this browser) before the work is done
 * and forgotten only once the record names the board, so a try that fails midway is picked up by the next one instead
 * of leaving a second board behind or a board with no first post. A board counts as made only once it has its first
 * post. A board that fails stops the run; the boards made before it are still named, and asking again finishes only
 * what is missing.
 *
 * Pure over its dependencies (the sender, the store, the id maker): `project-starter.test.mjs` drives it under
 * `node --test` with a fake server.
 */

import { missingStarterBoards, type StarterBoard } from "./starter-boards.ts";

/** What the run needs of the browser's storage. */
export interface StarterMemoStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The project the boards are for, on one server and by one founder. */
export interface StarterScope {
  relay: string;
  founder: string;
  projectId: string;
}

export function starterMemoKey(scope: StarterScope): string {
  const relay = scope.relay.trim().replace(/\/+$/, "").toLowerCase();
  return `creaton.projectBoards:${relay}:${scope.founder.toLowerCase()}:${scope.projectId}`;
}

/** What is remembered of one board: the id it is made under, and whether its first post was accepted. */
interface MemoEntry {
  id: string;
  seeded: boolean;
}

/** Board name to what was done for it and not yet named by the record. */
type Memo = Record<string, MemoEntry>;

function readMemo(store: StarterMemoStore, scope: StarterScope): Memo {
  try {
    const raw = store.getItem(starterMemoKey(scope));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const memo: Memo = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== "object") continue;
      const { id, seeded } = value as Partial<MemoEntry>;
      if (typeof id === "string" && id !== "")
        memo[name] = { id, seeded: seeded === true };
    }
    return memo;
  } catch {
    return {};
  }
}

function writeMemo(
  store: StarterMemoStore,
  scope: StarterScope,
  memo: Memo,
): void {
  try {
    if (Object.keys(memo).length === 0) store.removeItem(starterMemoKey(scope));
    else store.setItem(starterMemoKey(scope), JSON.stringify(memo));
  } catch {
    // Storage refused (a private window): the run still works, it only cannot be picked up after a failure.
  }
}

export interface StarterRun {
  scope: StarterScope;
  /** The boards the project already has. */
  existing: readonly { name: string; description: string }[];
  store: StarterMemoStore;
  newId: () => string;
  /** Whether the server already has a board with this id. A failure to answer is thrown. */
  exists: (id: string) => Promise<boolean>;
  /** Make the board. Throws with the server's reason when it refuses. */
  create: (board: StarterBoard, id: string) => Promise<void>;
  /** Post the board's first post. Throws with the server's reason when it refuses. */
  seed: (board: StarterBoard, id: string) => Promise<void>;
  /** Save the project's record naming these boards. Throws when the save is refused. */
  tie: (ids: string[]) => Promise<void>;
}

/**
 * Make the boards the project lacks and name them in its record. Resolves with the ids named. Rejects with the first
 * failure, after naming the boards made before it.
 */
export async function createProjectStarterBoards(
  run: StarterRun,
): Promise<string[]> {
  const missing = missingStarterBoards(run.existing);
  if (missing.length === 0) return [];
  const memo = readMemo(run.store, run.scope);
  const made: Array<{ name: string; id: string }> = [];
  let failure: unknown = null;
  for (const board of missing) {
    try {
      const entry = memo[board.name] ?? { id: run.newId(), seeded: false };
      memo[board.name] = entry;
      writeMemo(run.store, run.scope, memo);
      if (!(await run.exists(entry.id))) await run.create(board, entry.id);
      if (!entry.seeded) {
        await run.seed(board, entry.id);
        entry.seeded = true;
        writeMemo(run.store, run.scope, memo);
      }
      made.push({ name: board.name, id: entry.id });
    } catch (error) {
      failure = error;
      break;
    }
  }
  if (made.length > 0) {
    // A refused save keeps the memo (and throws): the next try reuses these boards.
    await run.tie(made.map((entry) => entry.id));
    for (const entry of made) delete memo[entry.name];
    writeMemo(run.store, run.scope, memo);
  }
  if (failure !== null) throw failure;
  return made.map((entry) => entry.id);
}
