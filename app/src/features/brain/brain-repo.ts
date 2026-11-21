/**
 * Where a project's brain lives and what is in it, as the app reads it. The brain is a folder of plain files in a git
 * repository (`buzz launchpad brain init`, docs/agents/MANAGER-LOOP.md section 5). A project record names no repository,
 * so the app finds it by one rule: the repository announcement (kind 30617) signed by the project's founder whose id is
 * `brain-<project id>`. The setup steps the app shows use that same id, so what a founder is told to create is what the
 * reader looks for. Nothing here reads the network: `brain-read.ts` and `use-brain.ts` do.
 */
import type { NostrEvent } from "../../lib/relay";

/** The kind of a repository announcement (NIP-34): the server lists every repository by one. */
export const KIND_REPO_ANNOUNCEMENT = 30617;

/** A repository id is 1 to 64 characters of letters, digits, dots, underscores and hyphens, with no leading dot. */
const REPO_ID_MAX = 64;
const REPO_ID_PREFIX = "brain-";

/** The id of a project's brain repository: `brain-` and the project's id, cut to the 64 characters a repository id may have. */
export function brainRepoId(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return `${REPO_ID_PREFIX}${safe}`.slice(0, REPO_ID_MAX);
}

/** The brain's files the reader looks for at the top of the repository, in the order they are listed. */
export const BRAIN_TOP_FILES = [
  "AGENTS.md",
  "facts.md",
  "voice.md",
  "decisions.md",
] as const;

/** The folder of the project's own repeatable jobs. */
export const BRAIN_PLAYBOOKS = "playbooks";

/** The most playbook files the reader lists. */
export const PLAYBOOKS_MAX = 20;

/** What the reader needs to ask the server for a project's brain. */
export interface BrainRepo {
  /** The repository's id. */
  id: string;
  /** The founder's key: the repository is addressed by its owner. */
  owner: string;
  /** Whether the founder bound the repository to a channel. Without one nobody can read it, its owner included. */
  bound: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

function tagValue(event: NostrEvent, name: string): string | null {
  const value = event.tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The project's brain repository from what the server returned for its founder's repository announcements, or null
 * when there is none. Only the founder's own announcement of the exact id counts, whatever else was returned; the
 * newest of several wins.
 */
export function findBrainRepo(
  events: readonly NostrEvent[],
  founder: string,
  projectId: string,
): BrainRepo | null {
  if (!HEX64.test(founder)) return null;
  const id = brainRepoId(projectId);
  const mine = events
    .filter(
      (event) =>
        event.kind === KIND_REPO_ANNOUNCEMENT &&
        event.pubkey === founder &&
        tagValue(event, "d") === id,
    )
    .sort((a, b) => b.created_at - a.created_at);
  const newest = mine[0];
  if (!newest) return null;
  return {
    id,
    owner: founder,
    bound: tagValue(newest, "buzz-channel") !== null,
  };
}
