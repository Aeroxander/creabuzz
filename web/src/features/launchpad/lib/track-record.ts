/**
 * A person's track record, worked out only from records whose signers prove them.
 *
 * As a helper: the work a project accepted from them, and how many of their tasks were sent back or given up. A task
 * counts only when a team member of that project who is not the helper signed the confirmation, and the team is read
 * from the project's own record (signed by its founder). The same rules as a project's page (`tasks.ts`) decide it.
 *
 * As a founder: the updates they posted on their own projects, and what came of the promises those updates made.
 *
 * There is no score here and nobody is compared with anybody. Anyone can start a project and confirm a friend's work
 * on it, so each accepted piece is listed with its project: the reader judges whose word it is.
 *
 * When a read was cut short the numbers are not stated at all.
 *
 * Pure and alias-free: `track-record.test.mjs` drives it under `node --test`.
 */

import type { AgentMark } from "./agent-label.ts";
import {
  type PromiseTotals,
  promiseRecord,
  promiseTotals,
  type RecordUpdate,
} from "./promises.ts";
import {
  acceptedTasks,
  projectTasks,
  type TaskFile,
  type TaskRecord,
} from "./tasks.ts";

interface AcceptedWork {
  taskId: string;
  coordinate: string;
  what: string;
  /** When the confirmation says it was signed. */
  at: number;
  confirmedBy: string;
  links: string[];
  files: TaskFile[];
}

export interface HelperRecord {
  /** Work accepted, newest confirmation first. */
  accepted: AcceptedWork[];
  /** Tasks that had work sent back at least once (whatever came of them later). */
  sentBack: number;
  givenUp: number;
  /** Tasks the person is on that are still open. */
  open: number;
  /** Tasks naming a project whose record could not be read: they are not counted either way. */
  unreadProjects: number;
  /** Set when the person's own task records say an agent signed them. */
  agent: AgentMark | null;
}

/**
 * `person`'s record as a helper. `records` are the task records that name them and the ones they signed, from any
 * projects; `teams` gives each project's team, by coordinate, for the projects whose record was read.
 */
export function helperRecord(input: {
  person: string;
  records: readonly TaskRecord[];
  teams: ReadonlyMap<string, ReadonlySet<string>>;
  offers?: ReadonlyMap<string, string>;
  now: number;
}): HelperRecord {
  const { person, records, teams, offers, now } = input;
  const coordinates = new Set(
    records
      .filter((record) => record.part === "task" && record.helper === person)
      .map((record) => record.coordinate),
  );
  const out: HelperRecord = {
    accepted: [],
    sentBack: 0,
    givenUp: 0,
    open: 0,
    unreadProjects: 0,
    agent: null,
  };
  const accepted: AcceptedWork[] = [];
  for (const coordinate of coordinates) {
    const team = teams.get(coordinate);
    if (!team) {
      out.unreadProjects += 1;
      continue;
    }
    const tasks = projectTasks({
      records,
      coordinate,
      team,
      offers,
      now,
    }).filter((task) => task.helper === person);
    for (const task of tasks) {
      // A task the person never agreed to says nothing about them.
      if (task.agreed === null) continue;
      if (task.helperAgent && (!out.agent || task.helperAgent.owner))
        out.agent = task.helperAgent;
      if (task.evidence.some((piece) => piece.sentBack.length > 0))
        out.sentBack += 1;
      if (task.state === "given-up") out.givenUp += 1;
      if (
        task.state === "in-progress" ||
        task.state === "submitted" ||
        task.state === "sent-back"
      )
        out.open += 1;
    }
    for (const task of acceptedTasks(tasks, now)) {
      if (!task.accepted) continue;
      accepted.push({
        taskId: task.id,
        coordinate,
        what: task.what,
        at: task.accepted.confirmedAt,
        confirmedBy: task.accepted.by,
        links: task.accepted.links,
        files: task.accepted.files,
      });
    }
  }
  out.accepted = accepted.sort(
    (a, b) =>
      Math.min(b.at, now) - Math.min(a.at, now) ||
      (a.taskId < b.taskId ? -1 : 1),
  );
  return out;
}

export interface FounderRecord {
  /** Projects the person's own update records are about. */
  projects: number;
  /** Weekly updates posted on their own projects. */
  updates: number;
  promises: PromiseTotals;
}

interface OwnUpdate extends RecordUpdate {
  /** `<founder>:<project id>`. */
  launchKey: string;
}

/**
 * `person`'s record as a founder, from the update records they signed. Only records about a project of their own
 * count (its coordinate carries their key), so nothing anyone else wrote can add to it.
 */
export function founderRecord(
  person: string,
  updates: readonly OwnUpdate[],
): FounderRecord {
  const byProject = new Map<string, OwnUpdate[]>();
  for (const update of updates) {
    if (update.author !== person) continue;
    if (!update.launchKey.startsWith(`${person}:`)) continue;
    const list = byProject.get(update.launchKey) ?? [];
    list.push(update);
    byProject.set(update.launchKey, list);
  }
  const totals: PromiseTotals = {
    kept: 0,
    missed: 0,
    changed: 0,
    unanswered: 0,
  };
  let posted = 0;
  let projects = 0;
  for (const list of byProject.values()) {
    const weekly = list.filter((update) => update.weekly);
    if (weekly.length === 0) continue;
    projects += 1;
    posted += weekly.length;
    const part = promiseTotals(promiseRecord(list, person));
    totals.kept += part.kept;
    totals.missed += part.missed;
    totals.changed += part.changed;
    totals.unanswered += part.unanswered;
  }
  return { projects, updates: posted, promises: totals };
}

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "3 pieces of work accepted". */
export function acceptedLine(n: number): string {
  return `${count(n, "piece", "pieces")} of work accepted`;
}

/** "1 task sent back, 2 given up", or null when there are none. */
export function missesLine(record: HelperRecord): string | null {
  if (record.sentBack + record.givenUp === 0) return null;
  return `${count(record.sentBack, "task", "tasks")} sent back at least once, ${record.givenUp} given up`;
}

/** "12 updates posted on 2 projects". */
export function updatesLine(record: FounderRecord): string {
  return `${count(record.updates, "update", "updates")} posted on ${count(record.projects, "project", "projects")}`;
}
