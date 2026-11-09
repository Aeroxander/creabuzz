/**
 * Making a project's supporters and founders boards: each board's creation and first post, then one save of the
 * project's record naming the boards that were made.
 *
 * The record is what makes a board the project's, so a board made but not yet named would sit on the server with no
 * project. Each id is remembered (in this browser) before its board is made and forgotten only once the record names
 * it, so a try that fails between the two is picked up by the next one instead of leaving a second board behind. A
 * board that fails stops the run; the boards made before it are still named, and asking again makes only what is missing.
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

/** Board name to the id made for it and not yet named by the record. */
function readMemo(
  store: StarterMemoStore,
  scope: StarterScope,
): Record<string, string> {
  try {
    const raw = store.getItem(starterMemoKey(scope));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeMemo(
  store: StarterMemoStore,
  scope: StarterScope,
  memo: Record<string, string>,
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
  /** Names of the boards the project already has. */
  existingNames: readonly string[];
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
  const missing = missingStarterBoards(run.existingNames);
  if (missing.length === 0) return [];
  const memo = readMemo(run.store, run.scope);
  const made: Array<{ name: string; id: string }> = [];
  let failure: unknown = null;
  for (const board of missing) {
    try {
      const id = memo[board.name] ?? run.newId();
      memo[board.name] = id;
      writeMemo(run.store, run.scope, memo);
      const alreadyMade = await run.exists(id);
      if (!alreadyMade) await run.create(board, id);
      made.push({ name: board.name, id });
      if (!alreadyMade) await run.seed(board, id);
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
