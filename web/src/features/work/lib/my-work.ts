/**
 * "Your work" on the Work page: the tasks a person took on, each with its four dated steps, offered, accepted,
 * handed in and checked.
 *
 * - A task is here only once the person signed a step for it themselves (a yes, work handed in, an ask for more
 *   time): a task that merely names them is not their work.
 * - Only tasks made by the project's team as it is now are listed.
 * - The dates are the ones the signers gave. They are shown, never used to decide a state, and one dated ahead of
 *   now is shown as now.
 * - Open tasks come first (late, then soonest due); finished ones after, newest check first. Never by a signer's
 *   date among open ones.
 *
 * Pure and alias-free: `my-work.test.mjs` drives it under `node --test`.
 */

import {
  isOpenTask,
  openTasks,
  orderTime,
  projectTasks,
  type TaskRecord,
  type TaskView,
} from "../../launchpad/lib/tasks.ts";

interface WorkStep {
  id: "offered" | "accepted" | "handed-in" | "checked";
  label: string;
  /** When the step's record says it was signed, or null when the step has not happened (or carries no date). */
  at: number | null;
  done: boolean;
}

interface MyWorkItem {
  task: TaskView;
  steps: WorkStep[];
}

const NO_TEAM: ReadonlySet<string> = new Set();

function stepsOf(
  task: TaskView,
  records: readonly TaskRecord[],
  now: number,
): WorkStep[] {
  const clamp = (at: number) => orderTime(at, now);
  const yes = records
    .filter(
      (record) =>
        record.part === "accept" &&
        record.taskId === task.id &&
        record.author === task.helper,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  const handed = task.evidence.length
    ? Math.max(...task.evidence.map((piece) => clamp(piece.at)))
    : null;
  const backs = [
    ...task.evidence.flatMap((piece) => piece.sentBack),
    ...task.orphanSendBacks,
  ];
  const checked: WorkStep = task.accepted
    ? {
        id: "checked",
        label: "Work accepted",
        at: clamp(task.accepted.confirmedAt),
        done: true,
      }
    : task.state === "sent-back" && backs.length > 0
      ? {
          id: "checked",
          label: "Sent back",
          at: Math.max(...backs.map((back) => clamp(back.at))),
          done: true,
        }
      : { id: "checked", label: "Checked", at: null, done: false };
  return [
    { id: "offered", label: "Offered", at: clamp(task.madeAt), done: true },
    {
      id: "accepted",
      label: task.agreed === "self" ? "Started" : "Accepted",
      at: yes
        ? clamp(yes.at)
        : task.agreed === "self"
          ? clamp(task.madeAt)
          : null,
      done: task.agreed !== null,
    },
    { id: "handed-in", label: "Handed in", at: handed, done: handed !== null },
    checked,
  ];
}

/** The tasks `person` took on, across the projects whose team is known, open ones first. */
export function myWork(input: {
  person: string;
  records: readonly TaskRecord[];
  teams: ReadonlyMap<string, ReadonlySet<string>>;
  now: number;
}): MyWorkItem[] {
  const { person, records, teams, now } = input;
  const coordinates = new Set(
    records
      .filter((record) => record.part === "task" && record.helper === person)
      .map((record) => record.coordinate),
  );
  const tasks: TaskView[] = [];
  for (const coordinate of [...coordinates].sort())
    tasks.push(
      ...projectTasks({
        records,
        coordinate,
        team: teams.get(coordinate) ?? NO_TEAM,
        now,
      }).filter((task) => task.helper === person && task.agreed !== null),
    );
  const closedAt = (task: TaskView) =>
    orderTime(
      task.accepted?.confirmedAt ?? task.gaveUp?.at ?? task.cancelled?.at ?? 0,
      now,
    );
  const closed = tasks
    .filter((task) => !isOpenTask(task))
    .sort((a, b) => closedAt(b) - closedAt(a) || (a.id < b.id ? -1 : 1));
  return [...openTasks(tasks), ...closed].map((task) => ({
    task,
    steps: stepsOf(task, records, now),
  }));
}
