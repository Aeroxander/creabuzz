/**
 * Which branches, tags and HEAD a repository has, read only from the record the community's own server signed.
 *
 * The server writes the repository-state record (kind 30618) itself after every push, signed with its own key, and
 * says which key that is in its public information (`self`). Anyone allowed to publish repository records could
 * publish a newer record for the same repository, so only the server's own key is believed: the query asks for that
 * author, and the answer is checked again here (author, repository and signature) because the page must not depend on
 * the server having applied the filter. When the server does not say which key it signs with, nothing is shown as
 * branches or tags; the page says so instead of believing whoever wrote last.
 *
 * Pure module: the network is passed in, so tests drive the same code the page runs.
 */

import { verifyEvent } from "nostr-tools/pure";

/** The repository-state record kind the server signs. */
const KIND_REPO_STATE = 30618;

export interface RepoRefs {
  branches: string[];
  tags: string[];
  head: { ref: string; sha: string } | null;
}

interface SignedEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** The server did not say which key signs its repository records, so no branches or tags can be believed. */
export class RepoSignerUnknownError extends Error {
  constructor() {
    super(
      "This server doesn't say which key it signs its code records with, so its branches and tags can't be shown safely. Ask whoever runs the server to give it a permanent signing key, then try again.",
    );
    this.name = "RepoSignerUnknownError";
  }
}

/** The server's public information could not be read at all. */
export class RepoSignerUnreachableError extends Error {
  constructor(reason: string) {
    super(
      `Couldn't read this server's information to check its branches and tags (${reason}). Check your connection and try again.`,
    );
    this.name = "RepoSignerUnreachableError";
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/** The server's own signing key from its public information document, or `null` when it does not state a valid one. */
export function relaySignerFromInfo(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const value = (info as { self?: unknown }).self;
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return HEX_KEY.test(key) ? key : null;
}

function dTag(event: SignedEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === "d")?.[1];
}

/**
 * The one record that decides the repository's refs: the newest record for `repoId` signed by `signer` with a valid
 * signature. Records by anyone else, for another repository, or with a bad signature are ignored, however new. Ties
 * on time go to the lowest id, as replaceable records are settled everywhere else.
 */
export function trustedRepoStateEvent<E extends SignedEvent>(
  events: readonly E[],
  repoId: string,
  signer: string,
  verify: (event: E) => boolean = (event) => verifyEvent(event as never),
): E | null {
  const want = signer.toLowerCase();
  let best: E | null = null;
  for (const event of events) {
    if (event.kind !== KIND_REPO_STATE) continue;
    if (event.pubkey.toLowerCase() !== want) continue;
    if (dTag(event) !== repoId) continue;
    if (!verify(event)) continue;
    if (
      !best ||
      event.created_at > best.created_at ||
      (event.created_at === best.created_at && event.id < best.id)
    ) {
      best = event;
    }
  }
  return best;
}

/** Branches, tags and HEAD as one repository-state record states them. */
function refsFromStateEvent(event: SignedEvent | null): RepoRefs {
  const branches: string[] = [];
  const tags: string[] = [];
  let headRef: string | null = null;
  const shas = new Map<string, string>();
  if (event) {
    for (const [name, value] of event.tags) {
      if (!name || !value) continue;
      if (name === "HEAD" && value.startsWith("ref: refs/heads/")) {
        headRef = value.slice("ref: refs/heads/".length);
      } else if (name.startsWith("refs/heads/")) {
        const branch = name.slice("refs/heads/".length);
        branches.push(branch);
        shas.set(branch, value);
      } else if (name.startsWith("refs/tags/")) {
        tags.push(name.slice("refs/tags/".length));
      }
    }
  }
  return {
    branches,
    tags,
    head: headRef ? { ref: headRef, sha: shas.get(headRef) ?? "" } : null,
  };
}

export interface RepoRefsDeps<E extends SignedEvent> {
  /** The server's public information document for `wsUrl` (throws when it cannot be read). */
  fetchInfo: (wsUrl: string) => Promise<unknown>;
  queryEvents: (
    wsUrl: string,
    filter: { kinds: number[]; authors: string[]; "#d": string[] },
  ) => Promise<E[]>;
  verify?: (event: E) => boolean;
}

/**
 * Read a repository's refs from the server at `wsUrl`, believing only that server's own key. The key is read from the
 * same server in the same call, so a key learned from another community is never used.
 */
export async function fetchRepoRefsFrom<E extends SignedEvent>(
  wsUrl: string,
  repoId: string,
  deps: RepoRefsDeps<E>,
): Promise<RepoRefs> {
  let info: unknown;
  try {
    info = await deps.fetchInfo(wsUrl);
  } catch (error) {
    throw new RepoSignerUnreachableError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const signer = relaySignerFromInfo(info);
  if (!signer) throw new RepoSignerUnknownError();
  const events = await deps.queryEvents(wsUrl, {
    kinds: [KIND_REPO_STATE],
    authors: [signer],
    "#d": [repoId],
  });
  return refsFromStateEvent(
    trustedRepoStateEvent(events, repoId, signer, deps.verify),
  );
}

/** Cache key for one repository's refs on one server: a different community never shares the answer. */
export function repoRefsQueryKey(wsUrl: string, repoId: string) {
  return ["repo-refs", wsUrl, repoId] as const;
}
