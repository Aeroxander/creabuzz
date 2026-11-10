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
import { projectTasks, type TaskFile, type TaskRecord } from "./tasks.ts";

export interface AcceptedWork {
  taskId: string;
  coordinate: string;
  what: string;
  /** When the confirmation says it was signed. */
  at: number;
  confirmedBy: string;
  /** The project's founder confirmed it (otherwise: someone else on its team). */
  byFounder: boolean;
  /** The person is on this project's own team: it is not outside work. */
  onTeam: boolean;
  /** The person made the task for themselves. */
  selfMade: boolean;
  /** Other accepted tasks made from the same offer, folded into this one: one offer is one piece of work. */
  sameOffer: number;
  links: string[];
  files: TaskFile[];
}

export interface HelperRecord {
  /** Work accepted, newest confirmation first. Several tasks from one offer are one entry. */
  accepted: AcceptedWork[];
  /** On how many projects, and confirmed by how many different people. */
  projects: number;
  confirmers: number;
  /** Projects where one person confirmed every piece (two or more): a reader should know. */
  soleConfirmer: Array<{ coordinate: string; by: string; pieces: number }>;
  /** Tasks that had work sent back at least once (whatever came of them later). */
  sentBack: number;
  /** Of those, the ones where the work that was sent back is no longer on the server. */
  sentBackWorkRemoved: number;
  /** Tasks the person took on and gave up, by their own signed yes and give-up, whatever came after. */
  givenUp: number;
  /** Tasks the person is on that are still open. */
  open: number;
  /** Tasks where the team recorded steps but no step signed by the person is there: not counted either way. */
  stepsMissing: number;
  /** Answers on the person's work by people who are not on those projects' teams now: shown, not counted. */
  outsideAnswers: number;
  /** Tasks the person took on that were made by someone who is not on the project's team now. */
  outsideTasks: number;
  /** Tasks naming a project whose record could not be read: only what the person signed themselves is counted. */
  unreadProjects: number;
  /** Set when the person's own task records say an agent signed them. */
  agent: AgentMark | null;
}

const NO_TEAM: ReadonlySet<string> = new Set();

/** The founder a project coordinate names (`37001:<founder>:<id>`). */
function founderOf(coordinate: string): string {
  return coordinate.split(":")[1] ?? "";
}

/**
 * `person`'s record as a helper. `records` are task records from any projects: the ones they signed, the tasks
 * those name, and what those projects' teams signed about them. `teams` gives each project's team as it is now, by
 * coordinate, for the projects whose record was read.
 *
 * Nothing here rests on a record that only names the person: a task says something about them only once they signed
 * a step for it themselves.
 */
export function helperRecord(input: {
  person: string;
  records: readonly TaskRecord[];
  teams: ReadonlyMap<string, ReadonlySet<string>>;
  now: number;
  /**
   * Whether the person (or whoever runs them) may have removed a record: they have removals on the server, or their
   * removals could not all be read. When it is known that they removed nothing, team steps that answer no step of
   * theirs are the team's own doing and say nothing about the person. Defaults to true.
   */
  mayHaveRemoved?: boolean;
}): HelperRecord {
  const { person, records, teams, now } = input;
  const mayHaveRemoved = input.mayHaveRemoved ?? true;
  const coordinates = new Set(
    records
      .filter((record) => record.part === "task" && record.helper === person)
      .map((record) => record.coordinate),
  );
  const out: HelperRecord = {
    accepted: [],
    projects: 0,
    confirmers: 0,
    soleConfirmer: [],
    sentBack: 0,
    sentBackWorkRemoved: 0,
    givenUp: 0,
    open: 0,
    stepsMissing: 0,
    outsideAnswers: 0,
    outsideTasks: 0,
    unreadProjects: 0,
    agent: null,
  };
  const accepted: AcceptedWork[] = [];
  for (const coordinate of [...coordinates].sort()) {
    const team = teams.get(coordinate);
    const tasks = projectTasks({
      records,
      coordinate,
      team: team ?? NO_TEAM,
      now,
      outsideTasks: true,
    }).filter((task) => task.helper === person);
    let counted = false;
    for (const task of tasks) {
      if (task.agreed === null) {
        // Never agreed to: it says nothing about them. Unless the team's steps answer something that is gone.
        if (task.stepRemoved && task.madeByTeam && mayHaveRemoved)
          out.stepsMissing += 1;
        continue;
      }
      counted = true;
      if (task.helperAgent && (!out.agent || task.helperAgent.owner))
        out.agent = task.helperAgent;
      // Their own signed yes and give-up stay theirs, whoever is on the team today and whatever came after.
      if (task.gaveUp) out.givenUp += 1;
      if (!task.madeByTeam) {
        if (team) out.outsideTasks += 1;
        continue;
      }
      const back = task.evidence.some((piece) => piece.sentBack.length > 0);
      if (back || task.orphanSendBacks.length > 0) out.sentBack += 1;
      if (task.orphanSendBacks.length > 0) out.sentBackWorkRemoved += 1;
      for (const piece of task.evidence)
        out.outsideAnswers += piece.outside.length;
      if (
        task.state === "in-progress" ||
        task.state === "submitted" ||
        task.state === "sent-back"
      )
        out.open += 1;
      if (task.state === "confirmed" && task.accepted)
        accepted.push({
          taskId: task.id,
          coordinate,
          what: task.what,
          at: task.accepted.confirmedAt,
          confirmedBy: task.accepted.by,
          byFounder: task.accepted.by === founderOf(coordinate),
          onTeam: team?.has(person) ?? false,
          selfMade: task.madeBy === person,
          sameOffer: 0,
          links: task.accepted.links,
          files: task.accepted.files,
          // Kept for folding below.
          ...(task.offerId ? { offerId: task.offerId } : {}),
        } as AcceptedWork & { offerId?: string });
    }
    if (!team && counted) out.unreadProjects += 1;
  }
  // One offer is one piece of work, however many tasks were made from it: the first by id stands for them all.
  const folded = new Map<string, AcceptedWork>();
  for (const work of accepted.sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
    const offerId = (work as AcceptedWork & { offerId?: string }).offerId;
    const key = offerId ? `${work.coordinate}:${offerId}` : work.taskId;
    const first = folded.get(key);
    if (first) first.sameOffer += 1;
    else {
      const { offerId: _, ...clean } = work as AcceptedWork & {
        offerId?: string;
      };
      folded.set(key, clean);
    }
  }
  out.accepted = [...folded.values()].sort(
    (a, b) =>
      Math.min(b.at, now) - Math.min(a.at, now) ||
      (a.taskId < b.taskId ? -1 : 1),
  );
  out.projects = new Set(out.accepted.map((w) => w.coordinate)).size;
  out.confirmers = new Set(out.accepted.map((w) => w.confirmedBy)).size;
  const byProject = new Map<string, AcceptedWork[]>();
  for (const work of out.accepted)
    byProject.set(work.coordinate, [
      ...(byProject.get(work.coordinate) ?? []),
      work,
    ]);
  for (const [coordinate, works] of byProject) {
    const who = new Set(works.map((w) => w.confirmedBy));
    if (works.length >= 2 && who.size === 1)
      out.soleConfirmer.push({
        coordinate,
        by: works[0].confirmedBy,
        pieces: works.length,
      });
  }
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

/** "3 pieces of work accepted, on 2 projects, confirmed by 2 people". */
export function acceptedLine(
  record: Pick<HelperRecord, "accepted" | "projects" | "confirmers">,
): string {
  const n = record.accepted.length;
  const base = `${count(n, "piece", "pieces")} of work accepted`;
  if (n === 0) return base;
  return `${base}, on ${count(record.projects, "project", "projects")}, confirmed by ${count(record.confirmers, "person", "people")}`;
}

/** "2 pieces of work accepted" for one project's own record. */
export function projectAcceptedLine(n: number): string {
  return `${count(n, "piece", "pieces")} of work accepted`;
}

/** "Confirmed by the project's founder" or "Confirmed by a team member", with who. */
export function confirmedByLine(
  work: Pick<AcceptedWork, "byFounder" | "confirmedBy">,
  name: (pubkey: string) => string,
): string {
  return work.byFounder
    ? `confirmed by the project's founder, ${name(work.confirmedBy)}`
    : `confirmed by a team member, ${name(work.confirmedBy)}`;
}

/** What a reader should know about the person's own tie to the project, or null for outside work. */
export function tieLine(
  work: Pick<AcceptedWork, "onTeam" | "selfMade">,
): string | null {
  if (work.selfMade)
    return "They made this task for themselves, and are on this project's team";
  if (work.onTeam) return "They were on this project's team";
  return null;
}

/** "1 task sent back at least once (the work on 1 was later removed), 2 given up", or null when there are none. */
export function missesLine(
  record: Pick<HelperRecord, "sentBack" | "sentBackWorkRemoved" | "givenUp">,
): string | null {
  if (record.sentBack + record.givenUp === 0) return null;
  const removed =
    record.sentBackWorkRemoved > 0
      ? ` (the work on ${record.sentBackWorkRemoved} was later removed)`
      : "";
  return `${count(record.sentBack, "task", "tasks")} sent back at least once${removed}, ${record.givenUp} given up`;
}

/** "12 updates posted on 2 projects". */
export function updatesLine(record: FounderRecord): string {
  return `${count(record.updates, "update", "updates")} posted on ${count(record.projects, "project", "projects")}`;
}
