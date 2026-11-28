/**
 * The join of the network's task queue and the team's own task records (plan section 4.4). A planned task on the network
 * is tied to the team's record by `what` (the record's event id, C4); every card, strip and alert asks this join for the
 * row of a record, the record of a row, and whether they tie (`tieOf`), so one rule decides it everywhere.
 *
 * `joinTasks` is pure. `useTaskJoin` is the one hook that reads the project's task records (one read per project, shared
 * through the app's query cache) and joins them to the signed record's rows.
 */
import { useMemo } from "react";
import type { ProjectNumbers } from "../../money/numbers";
import type { Project } from "../../project/project-record";
import type { ProjectTask } from "../task-record";
import { useProjectTasks } from "../use-tasks";
import { chainRowOf, type Tie, tieOf } from "./state";
import type { ChainTask, ChainTasks } from "./types";

/** A row of the network's queue, with the team's record of it when there is one. */
interface JoinedRow {
  row: ChainTask;
  /** The team's task record whose id is the row's `what`; null when the team has no such record (a plan made elsewhere). */
  task: ProjectTask | null;
  /** Whether the row ties to that record; `no-record` when there is none. */
  tie: Tie;
}

/** A team task record, with the network's row that stands for it when it was planned. */
interface JoinedTask {
  task: ProjectTask;
  /** The plan that binds the record (the lowest-serial row announced, taken or paid), or else the latest that ended. */
  chain: ChainTask | null;
  /** Whether that row ties to the record; null when the record has no plan on the network. */
  tie: Tie | null;
}

export interface TaskJoin {
  /** Every row of the queue, in the record's order (open first), with its record and tie. */
  rows: JoinedRow[];
  /** Every team record, newest first, with its plan. */
  tasks: JoinedTask[];
  /** The rows no team record names: "a planned task with no matching task here". */
  unmatched: JoinedRow[];
}

/** The record whose id is a row's `what`, or null. Ids are compared lower-case. */
function recordFor(row: ChainTask, byId: ReadonlyMap<string, ProjectTask>) {
  return byId.get(row.what.slice(2).toLowerCase()) ?? null;
}

/** Joins the queue of a record to the team's task records. Pure: the same inputs give the same join. */
export function joinTasks(
  queue: ChainTasks,
  records: readonly ProjectTask[],
): TaskJoin {
  const byId = new Map(records.map((t) => [t.id.toLowerCase(), t]));
  const rows = queue.list.map((row): JoinedRow => {
    const task = recordFor(row, byId);
    return { row, task, tie: tieOf(row, task) };
  });
  const tasks = records.map((task): JoinedTask => {
    const chain = chainRowOf(queue, task.id);
    return { task, chain, tie: chain ? tieOf(chain, task) : null };
  });
  return { rows, tasks, unmatched: rows.filter((r) => r.task === null) };
}

/** What `useTaskJoin` says. */
export type TaskJoinRead =
  /** The record has no queue to join (absent, null or unreadable): no queue screens. */
  | { status: "no-queue" }
  | { status: "loading" }
  /** The team's records could not be read: the queue's own rows still show, with no words of the team's. */
  | { status: "failed"; queue: ChainTasks; refetch: () => void }
  | { status: "ready"; queue: ChainTasks; join: TaskJoin; refetch: () => void };

/**
 * The project's task records joined to its queue. One read per project: the records come through `useProjectTasks`, whose
 * query is shared by every card, strip and alert on the page. `numbers` is the project's parsed record; with no queue in
 * it the hook reads nothing.
 */
export function useTaskJoin(
  project: Project | null,
  numbers: ProjectNumbers | null | undefined,
): TaskJoinRead {
  const queue =
    numbers && typeof numbers.tasks === "object" && numbers.tasks
      ? numbers.tasks
      : null;
  const read = useProjectTasks(project, queue !== null);
  const data = read.data?.tasks;
  const join = useMemo(
    () => (queue && data ? joinTasks(queue, data) : null),
    [queue, data],
  );
  if (!queue) return { status: "no-queue" };
  if (join)
    return { status: "ready", queue, join, refetch: () => void read.refetch() };
  if (read.isError)
    return { status: "failed", queue, refetch: () => void read.refetch() };
  return { status: "loading" };
}
