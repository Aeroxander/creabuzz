/**
 * How task records are read: by who signed them, never only by what they name.
 *
 * Anyone can sign a record that names a project (`a`), a person (`p`) or the task label (`l`). A read by those tags
 * alone can be filled with junk by a stranger until it never reaches its end, and then nothing could be stated as
 * fact. So what counts is read by author:
 *
 * - a project: the task records its team signed (the tasks, and the team's steps), then the steps signed by the
 *   helpers those tasks name. A stranger's records are not in either read, however many there are;
 * - a person: the steps they signed themselves, then the tasks those steps name (by id), then each of those
 *   projects' own record (for its team), then what each team signed about those tasks.
 *
 * One more read, a single page by tag, picks up answers from people who are not on a team now (they may have been).
 * Those are shown as that and never counted, so that read being cut changes no number; it is still said.
 *
 * Every read is paged to a bound, and the result says when any of them did not reach its end.
 *
 * Pure and alias-free: `task-reads.test.mjs` drives it under `node --test` against a small in-memory server.
 */

import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "../../../shared/constants/kinds.ts";
import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";
import { EVIDENCE_QUERY_LIMIT, readPaged } from "./evidence-query.ts";
import { parseTaskRecord, TASK_LABEL, type TaskRecord } from "./tasks.ts";

interface Ev {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

type Fetch<E> = (filter: NostrFilter) => Promise<readonly E[]>;

/** How many team members' records are read for one project. A larger team makes the read incomplete. */
const TEAM_READ = 20;
/** How many helpers' steps are read for one project. */
const HELPERS_READ = 200;
/** How many authors one read names. */
const AUTHORS_PER_READ = 50;
/** How many ids one read names. */
const IDS_PER_READ = 100;
/** How many tasks a person's record follows. */
const PERSON_TASKS = 1000;
/** How many projects a person's record reads the team of. */
export const TRACK_PROJECTS = 40;

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const recordsOf = <E extends Ev>(events: readonly E[]): TaskRecord[] =>
  events.flatMap((event) => {
    if (event.kind !== KIND_LAUNCH_UPDATE) return [];
    const record = parseTaskRecord(event);
    return record ? [record] : [];
  });

class Gathered<E extends Ev> {
  readonly events = new Map<string, E>();
  complete = true;
  add(events: readonly E[], keep: (event: E) => boolean = () => true) {
    for (const event of events)
      if (keep(event) && !this.events.has(event.id))
        this.events.set(event.id, event);
  }
  async paged(
    fetch: Fetch<E>,
    filter: () => NostrFilter,
    keep?: (event: E) => boolean,
  ) {
    const page = await readPaged(fetch, () => ({
      ...filter(),
      limit: EVIDENCE_QUERY_LIMIT,
    }));
    this.add(page.events, keep);
    if (!page.complete) this.complete = false;
  }
}

export interface TaskRead<E> {
  events: E[];
  /** Everything that is counted was read to its end. */
  complete: boolean;
  /** The one page of other people's answers was full: some of those (never counted) are not shown. */
  othersCut: boolean;
}

/** One project's task records: its team's, then its helpers', then one page of anyone else's answers. */
export async function readProjectTasks<E extends Ev>(
  fetch: Fetch<E>,
  project: { coordinate: string; team: readonly string[] },
): Promise<TaskRead<E>> {
  const { coordinate } = project;
  const got = new Gathered<E>();
  const team = project.team.slice(0, TEAM_READ);
  if (project.team.length > TEAM_READ) got.complete = false;
  const about = { "#a": [coordinate], "#l": [TASK_LABEL] };
  await got.paged(
    fetch,
    () => ({ kinds: [KIND_LAUNCH_UPDATE], authors: team, ...about }),
    // What comes back is checked again: only what a team member signed.
    (event) => team.includes(event.pubkey),
  );
  const onTeam = new Set(team);
  const helpers = [
    ...new Set(
      recordsOf([...got.events.values()])
        .filter((r) => r.part === "task" && r.coordinate === coordinate)
        .flatMap((r) => (r.helper && !onTeam.has(r.helper) ? [r.helper] : [])),
    ),
  ].sort();
  if (helpers.length > HELPERS_READ) got.complete = false;
  for (const authors of chunks(
    helpers.slice(0, HELPERS_READ),
    AUTHORS_PER_READ,
  ))
    await got.paged(
      fetch,
      () => ({ kinds: [KIND_LAUNCH_UPDATE], authors, ...about }),
      (event) => authors.includes(event.pubkey),
    );
  // Anyone else's answers, for showing only: one page, by tag.
  const others = await fetch({
    kinds: [KIND_LAUNCH_UPDATE],
    ...about,
    limit: EVIDENCE_QUERY_LIMIT,
  });
  got.add(others);
  return {
    events: [...got.events.values()],
    complete: got.complete,
    othersCut: others.length >= EVIDENCE_QUERY_LIMIT,
  };
}

export interface PersonTaskRead<E> extends TaskRead<E> {
  /** The newest record of each project the person's tasks name, for the projects that were read. */
  projects: E[];
  /** The person's tasks name more projects than are read: the rest are not counted. */
  tooManyProjects: boolean;
}

/**
 * The task records one person's track record rests on. `teamOf` reads a project record's team (its founder first).
 * Nothing is found through a record that only names the person: the read starts from what they signed.
 */
export async function readPersonTasks<E extends Ev>(
  fetch: Fetch<E>,
  person: string,
  teamOf: (record: E) => { coordinate: string; team: string[] } | null,
): Promise<PersonTaskRead<E>> {
  const got = new Gathered<E>();
  await got.paged(
    fetch,
    () => ({
      kinds: [KIND_LAUNCH_UPDATE],
      authors: [person],
      "#l": [TASK_LABEL],
    }),
    (event) => event.pubkey === person,
  );
  const own = recordsOf([...got.events.values()]);
  const have = new Set(own.filter((r) => r.part === "task").map((r) => r.id));
  const named = [
    ...new Set(own.filter((r) => r.part !== "task").map((r) => r.taskId)),
  ]
    .filter((id) => !have.has(id))
    .sort();
  if (named.length > PERSON_TASKS) got.complete = false;
  for (const ids of chunks(named.slice(0, PERSON_TASKS), IDS_PER_READ)) {
    const found = await fetch({
      kinds: [KIND_LAUNCH_UPDATE],
      ids,
      limit: ids.length,
    });
    got.add(found, (event) => ids.includes(event.id));
  }
  // The person's tasks: the ones that name them as the helper, among what they signed a step for (or made).
  const tasks = recordsOf([...got.events.values()]).filter(
    (r) => r.part === "task" && r.helper === person,
  );
  const all = [...new Set(tasks.map((r) => r.coordinate))].sort();
  const coordinates = all.slice(0, TRACK_PROJECTS);
  const wanted = coordinates.flatMap((coordinate) => {
    const [kind, author, ...rest] = coordinate.split(":");
    const id = rest.join(":");
    return kind === String(KIND_LAUNCH_RECORD) && author && id
      ? [{ coordinate, author, id }]
      : [];
  });
  const newest = new Map<string, E>();
  const teams = new Map<string, string[]>();
  if (wanted.length > 0) {
    const page = await readPaged(fetch, () => ({
      kinds: [KIND_LAUNCH_RECORD],
      authors: [...new Set(wanted.map((w) => w.author))],
      "#d": [...new Set(wanted.map((w) => w.id))],
      limit: EVIDENCE_QUERY_LIMIT,
    }));
    if (!page.complete) got.complete = false;
    for (const event of page.events) {
      const read = teamOf(event);
      if (!read || !wanted.some((w) => w.coordinate === read.coordinate))
        continue;
      const prev = newest.get(read.coordinate);
      if (!prev || event.created_at > prev.created_at) {
        newest.set(read.coordinate, event);
        teams.set(read.coordinate, read.team);
      }
    }
  }
  const allIds: string[] = [];
  for (const [coordinate, members] of teams) {
    const team = members.slice(0, TEAM_READ);
    if (members.length > TEAM_READ) got.complete = false;
    const ids = tasks
      .filter((r) => r.coordinate === coordinate)
      .map((r) => r.id)
      .sort();
    allIds.push(...ids);
    for (const chunk of chunks(ids, IDS_PER_READ))
      await got.paged(
        fetch,
        () => ({
          kinds: [KIND_LAUNCH_UPDATE],
          authors: team,
          "#e": chunk,
          "#l": [TASK_LABEL],
        }),
        (event) => team.includes(event.pubkey),
      );
  }
  let othersCut = false;
  if (allIds.length > 0) {
    const others = await fetch({
      kinds: [KIND_LAUNCH_UPDATE],
      "#e": allIds.slice(0, IDS_PER_READ),
      "#l": [TASK_LABEL],
      limit: EVIDENCE_QUERY_LIMIT,
    });
    got.add(others);
    othersCut =
      others.length >= EVIDENCE_QUERY_LIMIT || allIds.length > IDS_PER_READ;
  }
  return {
    events: [...got.events.values()],
    complete: got.complete,
    othersCut,
    projects: [...newest.values()],
    tooManyProjects: all.length > TRACK_PROJECTS,
  };
}
