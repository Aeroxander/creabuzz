/**
 * Which boards belong to which project.
 *
 * A project's record already names the channels it links to (the `buzz-channel` tags the server checks and caps) and its
 * own board (`chat.board`). A board is a project's board when its record names it, so the tie is one the project's
 * founder signs, survives a reload and is read by every client that reads projects. The server writes a board's own
 * record from the board's name, description and visibility only, so a tag on the board itself would not come back.
 * Boards no record names stay server boards, and keep working as before.
 *
 * Alias-free; `project-boards.test.mjs` drives it under `node --test`.
 */

import { MAX_BOUND_CHANNELS } from "../../launchpad/lib/launch-chat.ts";
import { parseMembers } from "./members.ts";

/** The parts of a project's record this module reads. */
export interface TiedRecord {
  id: string;
  author: string;
  name: string;
  /** Every channel the record names, rooms and boards alike. */
  channels: readonly string[];
  chat: {
    team: string | null;
    supporters: string | null;
    backers: string | null;
    board: string | null;
  };
}

/** A project, for pointing at it and for the channels it names. */
export interface ProjectRef {
  /** Author and id together: the project's own key (ids are only unique per author). */
  key: string;
  id: string;
  author: string;
  name: string;
}

export interface BoardProject extends ProjectRef {
  /** The board the record calls its own, when it has one. */
  ownBoard: string | null;
  /** Channels the record names, its own board first. Rooms are in here too; only boards are ever looked up. */
  channelIds: readonly string[];
}

export function projectKey(author: string, id: string): string {
  return `${author.toLowerCase()}:${id}`;
}

/** The project a record describes, with the channels it names. */
export function boardProject(record: TiedRecord): BoardProject {
  const ids = [record.chat.board, ...record.channels]
    .filter((id): id is string => typeof id === "string" && id !== "")
    .map((id) => id.toLowerCase());
  return {
    key: projectKey(record.author, record.id),
    id: record.id,
    author: record.author,
    name: record.name,
    ownBoard: record.chat.board ? record.chat.board.toLowerCase() : null,
    channelIds: [...new Set(ids)],
  };
}

/**
 * Who runs each board, from the membership records (kind 39002) the server returned: the people whose role is `owner`.
 * Only the newest record for a board counts. Board ids are lower case, as in `BoardProject`.
 */
export function boardOwners(
  records: readonly { created_at: number; tags: string[][] }[],
): Map<string, ReadonlySet<string>> {
  const newest = new Map<string, { created_at: number; tags: string[][] }>();
  for (const record of records) {
    const d = record.tags.find((tag) => tag[0] === "d")?.[1];
    if (!d) continue;
    const key = d.toLowerCase();
    const seen = newest.get(key);
    if (!seen || record.created_at > seen.created_at) newest.set(key, record);
  }
  return new Map(
    [...newest].map(([id, record]) => [
      id,
      new Set(
        parseMembers(record.tags)
          .filter((member) => member.role === "owner")
          .map((member) => member.pubkey.toLowerCase()),
      ),
    ]),
  );
}

/**
 * The project with only the boards its founder runs. A record is the founder's own word, so a board it names counts as
 * the project's only when the server says the founder owns that board. Anyone can type another person's board id (or a
 * plain server board's) into their own record; without this check it would be listed under their project and, as the
 * record's "own board", would win it away from the project that made it. A board with no owner read (nothing known
 * about it) is not counted.
 */
export function boardsTheFounderRuns(
  project: BoardProject,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
): BoardProject {
  const founder = project.author.toLowerCase();
  const channelIds = project.channelIds.filter((id) =>
    owners.get(id)?.has(founder),
  );
  return {
    ...project,
    ownBoard:
      project.ownBoard !== null && channelIds.includes(project.ownBoard)
        ? project.ownBoard
        : null,
    channelIds,
  };
}

/**
 * How to tell projects apart in a list: the words to put after a project's name. A name shared by two projects is followed by who made it, and by the project's
 * address too when the same person made both; a name that is alone stays as it is. `nameOf` gives a founder's name.
 * Keyed by project key.
 */
export function projectQualifiers(
  projects: readonly ProjectRef[],
  nameOf: (pubkey: string) => string,
): Map<string, string | null> {
  const nameKey = (project: ProjectRef) => project.name.trim().toLowerCase();
  /** Projects by what they read like so far. */
  const alike = (read: (project: ProjectRef) => string) => {
    const groups = new Map<string, ProjectRef[]>();
    for (const project of projects) {
      const key = `${nameKey(project)}\n${read(project)}`;
      groups.set(key, [...(groups.get(key) ?? []), project]);
    }
    return (project: ProjectRef) =>
      groups.get(`${nameKey(project)}\n${read(project)}`) ?? [];
  };
  const sameName = alike(() => "");
  const sameMaker = alike((project) => nameOf(project.author));
  const sameAddress = alike(
    (project) => `${nameOf(project.author)}\n${project.id}`,
  );
  return new Map(
    projects.map((project): [string, string | null] => {
      if (sameName(project).length < 2) return [project.key, null];
      const by = `by ${nameOf(project.author)}`;
      if (sameMaker(project).length < 2) return [project.key, by];
      const at = `${by} (${project.id})`;
      const twins = sameAddress(project);
      if (twins.length < 2) return [project.key, at];
      // The same name, maker and address (two people who share a name): their order is all that tells them apart.
      const order = [...twins].sort((x, y) => (x.key < y.key ? -1 : 1));
      return [
        project.key,
        `${at}, ${order.indexOf(project) + 1} of ${order.length}`,
      ];
    }),
  );
}

/** One group of boards on Home: a project's, or the server's own (`project` null). */
export interface BoardGroup<T> {
  project: ProjectRef | null;
  boards: T[];
}

/**
 * The project each board belongs to. A board two records name goes to the one that made it its own board, then to the
 * lowest key, so it never flips between reloads.
 */
function owners(projects: readonly BoardProject[]): Map<string, BoardProject> {
  const own = new Map<string, { rank: number; project: BoardProject }>();
  for (const project of projects) {
    for (const id of project.channelIds) {
      const rank = id === project.ownBoard ? 0 : 1;
      const seen = own.get(id);
      if (
        !seen ||
        rank < seen.rank ||
        (rank === seen.rank && project.key < seen.project.key)
      ) {
        own.set(id, { rank, project });
      }
    }
  }
  return new Map([...own].map(([id, { project }]) => [id, project]));
}

/**
 * Boards grouped under their project, a project's boards in the order given. Groups come in the order their first board
 * appears (so the busiest or joined first stays first), with the server's own boards last. A board no project names,
 * or one a project names that is not in `boards`, is a server board.
 */
export function groupBoardsByProject<T extends { id: string }>(
  boards: readonly T[],
  projects: readonly BoardProject[],
): BoardGroup<T>[] {
  const owner = owners(projects);
  const groups = new Map<string, BoardGroup<T>>();
  const server: T[] = [];
  for (const board of boards) {
    const project = owner.get(board.id.toLowerCase());
    if (!project) {
      server.push(board);
      continue;
    }
    const group = groups.get(project.key) ?? {
      project: {
        key: project.key,
        id: project.id,
        author: project.author,
        name: project.name,
      },
      boards: [],
    };
    group.boards.push(board);
    groups.set(project.key, group);
  }
  return [
    ...groups.values(),
    ...(server.length > 0 ? [{ project: null, boards: server }] : []),
  ];
}

/** The boards one project names, its own board first and then in the order the record lists them. */
export function boardsOfProject<T extends { id: string }>(
  project: BoardProject,
  boards: readonly T[],
): T[] {
  const byId = new Map(boards.map((board) => [board.id.toLowerCase(), board]));
  return project.channelIds
    .map((id) => byId.get(id))
    .filter((board): board is T => board !== undefined);
}

/**
 * The channels a record should name after boards are added to it. The record's own rooms and board stay (they have
 * places of their own in the record). A record names at most `MAX_BOUND_CHANNELS`, so when it is full the new boards
 * are kept first, then boards it already named, then any other channel the founder picked; `dropped` counts the picks
 * that no longer fit. What is kept is listed with the boards it already had first, so a project's boards read in the
 * order they were added.
 */
export function tieBoards(
  record: Pick<TiedRecord, "channels" | "chat">,
  added: readonly string[],
  existingBoardIds: ReadonlySet<string>,
): { channels: string[]; dropped: number } {
  const own = new Set(
    [
      record.chat.team,
      record.chat.supporters,
      record.chat.backers,
      record.chat.board,
    ].filter((id): id is string => Boolean(id)),
  );
  const fresh = [...new Set(added)].filter((id) => !own.has(id));
  const named = record.channels.filter(
    (id) => !own.has(id) && !fresh.includes(id),
  );
  const boards = named.filter((id) => existingBoardIds.has(id));
  const others = named.filter((id) => !existingBoardIds.has(id));
  const room = Math.max(0, MAX_BOUND_CHANNELS - own.size);
  const keep = new Set([...fresh, ...boards, ...others].slice(0, room));
  return {
    channels: [...boards, ...fresh, ...others].filter((id) => keep.has(id)),
    dropped: fresh.length + boards.length + others.length - keep.size,
  };
}

/** What to tell a founder when adding boards pushed links they had added earlier out of the project; null when none were. */
export function droppedLinksNotice(
  projectName: string,
  dropped: number,
): string | null {
  if (dropped <= 0) return null;
  return `${projectName} can link at most ${MAX_BOUND_CHANNELS} rooms and boards, so ${
    dropped === 1
      ? "one you linked earlier is"
      : `${dropped} you linked earlier are`
  } no longer linked.`;
}
