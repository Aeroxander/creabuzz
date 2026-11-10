/**
 * What to tell someone about tasks: each step that needs them, or answers something they did.
 *
 * To the helper: a task was given to them to say yes or no to (an offer they made is never a yes); their work was sent back or
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
  /**
   * When this browser first saw each record, by id. A record's own date is its signer's to write, so a notice is
   * never dated later than when it was first seen: one dated in the future cannot sit on top, and cannot turn
   * unread again once that date comes round.
   */
  firstSeen?: ReadonlyMap<string, number>;
  limit?: number;
}): TaskNotice[] {
  const { naming, viewer, muted, now, firstSeen, limit = 100 } = input;
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
      actor: step.author,
      at: Math.min(step.at, firstSeen?.get(step.id) ?? now),
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

/** "… gave you a task to say yes or no to: …": the words between the person's name and the task. */
export function noticeVerb(notice: Pick<TaskNotice, "part">): string {
  switch (notice.part) {
    case "task":
      return "gave you a task to say yes or no to:";
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
      return "said no to, or gave up, the task:";
    case "cancel":
      return "cancelled the task:";
  }
}

/** How many first-seen times are kept. */
const FIRST_SEEN_KEPT = 400;

/**
 * The first-seen times to keep after showing `notices`: what was kept before, plus `now` for each one not seen
 * before, cut to the newest {@link FIRST_SEEN_KEPT}. Null when nothing changed.
 */
export function nextFirstSeen(
  kept: ReadonlyMap<string, number>,
  ids: readonly string[],
  now: number,
): Map<string, number> | null {
  const fresh = ids.filter((id) => !kept.has(id));
  if (fresh.length === 0) return null;
  const all = new Map(kept);
  for (const id of fresh) all.set(id, now);
  return new Map(
    [...all].sort((a, b) => b[1] - a[1]).slice(0, FIRST_SEEN_KEPT),
  );
}
