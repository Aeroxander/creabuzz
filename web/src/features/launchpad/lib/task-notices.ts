/**
 * What to tell someone about tasks: each step that needs them, or answers something they did.
 *
 * To the helper: a task was made from their offer, or given to them to say yes to; their work was sent back or
 * confirmed; more time was given; the task was cancelled. To the team: the helper said yes, handed work in, asked for
 * more time, or gave up.
 *
 * A step only becomes a notice when the right party signed it, by the same rules a project's page uses (`tasks.ts`):
 * a "confirmation" from someone who is not on the project's team tells nobody anything.
 *
 * Pure and alias-free: `task-notices.test.mjs` drives it under `node --test`.
 */

import type { TaskPart, TaskRecord } from "./tasks.ts";

interface NoticeProject {
  id: string;
  author: string;
  name: string;
  team: ReadonlyArray<{ pubkey: string }>;
}

export interface TaskNotice {
  id: string;
  part: TaskPart;
  /** A task made from the viewer's own offer (so it needs no yes from them). */
  fromOffer: boolean;
  actor: string;
  at: number;
  note: string;
  project: NoticeProject;
  taskId: string;
  what: string;
}

const FROM_HELPER: readonly TaskPart[] = [
  "accept",
  "evidence",
  "more-time",
  "give-up",
];

/**
 * Notices for `viewer`, newest first, at most `limit`. `naming` are the task records that name the viewer; `tasks`
 * are the task records those steps are about (the ones in `naming`, and any read for them since).
 */
export function taskNotices(input: {
  naming: readonly TaskRecord[];
  tasks: readonly TaskRecord[];
  projects: readonly NoticeProject[];
  viewer: string;
  muted?: ReadonlySet<string>;
  now: number;
  limit?: number;
}): TaskNotice[] {
  const { naming, viewer, muted, now, limit = 20 } = input;
  const projects = new Map(
    input.projects.map((p) => [`37001:${p.author}:${p.id}`, p]),
  );
  const tasks = new Map<string, TaskRecord>();
  for (const record of [...input.tasks, ...naming])
    if (record.part === "task") tasks.set(record.id, record);
  const seen = new Set<string>();
  const out: TaskNotice[] = [];
  for (const step of naming) {
    if (seen.has(step.id) || step.author === viewer) continue;
    seen.add(step.id);
    if (muted?.has(step.author.toLowerCase())) continue;
    const task = tasks.get(step.taskId);
    if (!task?.helper || task.coordinate !== step.coordinate) continue;
    const project = projects.get(task.coordinate);
    if (!project) continue;
    const team = new Set([
      project.author,
      ...project.team.map((m) => m.pubkey),
    ]);
    // Only the team makes a project's tasks.
    if (!team.has(task.author)) continue;
    const helper = task.helper;
    if (step.part === "task") {
      if (helper !== viewer) continue;
    } else if (FROM_HELPER.includes(step.part)) {
      // The helper's steps are for the team.
      if (step.author !== helper || !team.has(viewer)) continue;
    } else {
      // The team's steps are for the helper, and count only from a team member who is not the helper.
      if (helper !== viewer || !team.has(step.author) || step.author === helper)
        continue;
      if (step.part === "confirm" && step.agent !== null) continue;
    }
    out.push({
      id: step.id,
      part: step.part,
      fromOffer: step.part === "task" && step.offerId !== null,
      actor: step.author,
      // Never later than now: a record dated in the future must not sit on top, or pass for unread for ever.
      at: Math.min(step.at, now),
      note: step.note,
      project,
      taskId: task.id,
      what: task.what,
    });
  }
  return out
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

/** "… accepted your offer and made it a task: …" — the words between the person's name and the task. */
export function noticeVerb(
  notice: Pick<TaskNotice, "part" | "fromOffer">,
): string {
  switch (notice.part) {
    case "task":
      return notice.fromOffer
        ? "accepted your offer and made it a task:"
        : "gave you a task to say yes or no to:";
    case "accept":
      return "said yes to the task:";
    case "evidence":
      return "handed in work for you to check on:";
    case "send-back":
      return "sent your work back on:";
    case "confirm":
      return "confirmed your work on:";
    case "more-time":
      return "asked for more time on:";
    case "grant":
      return "gave you more time on:";
    case "give-up":
      return "gave up the task:";
    case "cancel":
      return "cancelled the task:";
  }
}
