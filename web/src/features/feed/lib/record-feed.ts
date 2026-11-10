/**
 * Home's feed of project records: what the projects in view put on the record, newest first.
 *
 * One item per signed record, and only from the party entitled to sign it: an update from the project's founder or
 * team (with the founder's answers to earlier promises, and the help it asks for), a goal the founder marked reached,
 * missed or changed, and work the team accepted (worked out with the same rules as the project's own page:
 * `projectTasks`). Anything else that names a project is not an item, whoever signed it.
 *
 * Order is by the time each record says it was signed, never later than now: the server takes no record dated more
 * than a quarter of an hour ahead, and a record dated ahead is shown as signed now, not above everything for good.
 *
 * Pure and alias-free: `record-feed.test.mjs` drives it under `node --test`.
 */

import {
  type GoalState,
  isGoalRecordTags,
  parseGoalVersion,
} from "../../launchpad/lib/goals.ts";
import { isHelpSignalTags } from "../../launchpad/lib/help-request.ts";
import {
  isTaskRecordTags,
  projectTasks,
  type TaskRecord,
} from "../../launchpad/lib/tasks.ts";
import { isTeamAnswerTags } from "../../launchpad/lib/team.ts";
import type { HelpAsk } from "../../launchpad/lib/weekly-update.ts";
import {
  type LaunchUpdate,
  parseLaunchUpdate,
} from "../../launchpad/models.ts";

/** Records read per page of the feed, and at most this many pages. */
export const FEED_PAGE = 100;
export const FEED_MAX_PAGES = 10;
/** The most projects one feed follows, and the most accounts (their teams) one page names. */
export const FEED_PROJECTS = 40;
export const FEED_AUTHORS = 200;

export interface FeedProject {
  coordinate: string;
  founder: string;
  /** The founder and everyone on the founder's record. */
  team: ReadonlySet<string>;
}

interface FeedEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface ItemBase {
  /** Unique in the feed. */
  id: string;
  /** When it was signed, never later than now. */
  at: number;
  coordinate: string;
  author: string;
}

export interface UpdateItem extends ItemBase {
  kind: "update";
  /** The update as the project's page reads it (its help request is answered through this). */
  update: LaunchUpdate;
  help: HelpAsk | null;
  /** The founder's answers to earlier promises in this update; all zero for anyone else's update. */
  answers: { kept: number; missed: number; changed: number };
  /** The promises this update makes (the founder's only). */
  promises: string[];
}

interface GoalItem extends ItemBase {
  kind: "goal";
  state: Exclude<GoalState, "open">;
  text: string;
  reason: string;
}

interface WorkItem extends ItemBase {
  kind: "work";
  taskId: string;
  what: string;
  helper: string;
}

export type FeedItem = UpdateItem | GoalItem | WorkItem;

/**
 * The feed's items from the records read. `events` are update records naming the projects in view; `taskRecords` are
 * the tasks (and their steps) that the confirmations among them name.
 */
export function feedItems(input: {
  events: readonly FeedEvent[];
  projects: ReadonlyMap<string, FeedProject>;
  taskRecords: readonly TaskRecord[];
  /** Now, in seconds. */
  now: number;
}): FeedItem[] {
  const { projects, now } = input;
  const out = new Map<string, FeedItem>();
  for (const event of input.events) {
    if (event.kind !== 47003 || out.has(event.id)) continue;
    const coordinate = event.tags.find(
      (tag) => tag[0] === "a" && projects.has(tag[1]),
    )?.[1];
    const project = coordinate ? projects.get(coordinate) : undefined;
    if (!coordinate || !project) continue;
    const base = {
      id: event.id,
      at: Math.min(event.created_at, now),
      coordinate,
      author: event.pubkey,
    };
    if (isGoalRecordTags(event.tags)) {
      // A goal is the founder's alone.
      if (event.pubkey !== project.founder) continue;
      const goal = parseGoalVersion(event);
      if (!goal || goal.state === "open") continue;
      out.set(event.id, {
        ...base,
        kind: "goal",
        state: goal.state,
        text: goal.text,
        reason: goal.reason,
      });
      continue;
    }
    // Work accepted comes from the task records below; an offer, a reply or a team answer is not news.
    if (
      isTaskRecordTags(event.tags) ||
      isHelpSignalTags(event.tags) ||
      isTeamAnswerTags(event.tags)
    )
      continue;
    // Only the project's team speaks as the project.
    if (!project.team.has(event.pubkey)) continue;
    const update = parseLaunchUpdate(event);
    // Submitted work and check notes are shown with the work, not as news.
    if (!update || update.claim || update.checkNote) continue;
    const byFounder = event.pubkey === project.founder;
    const marks = byFounder ? (update.marks ?? []) : [];
    out.set(event.id, {
      ...base,
      kind: "update",
      update,
      help: update.help ?? null,
      answers: {
        kept: marks.filter((m) => m.state === "done").length,
        missed: marks.filter((m) => m.state === "not-done").length,
        changed: marks.filter((m) => m.state === "changed").length,
      },
      promises: byFounder ? (update.promises ?? []).map((p) => p.text) : [],
    });
  }
  for (const project of projects.values()) {
    const tasks = projectTasks({
      records: input.taskRecords,
      coordinate: project.coordinate,
      team: project.team,
      now,
    });
    for (const task of tasks) {
      if (task.state !== "confirmed" || !task.accepted) continue;
      out.set(`work:${task.id}`, {
        id: `work:${task.id}`,
        kind: "work",
        at: Math.min(task.accepted.confirmedAt, now),
        coordinate: project.coordinate,
        author: task.accepted.by,
        taskId: task.id,
        what: task.what,
        helper: task.helper,
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => b.at - a.at || (a.id < b.id ? -1 : 1),
  );
}

/** The ids of the tasks the confirmations in `events` name: the ones whose records the feed reads next. */
export function confirmedTaskIds(events: readonly FeedEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event.tags.some((t) => t[0] === "task-part" && t[1] === "confirm"))
      continue;
    const id = event.tags.find((t) => t[0] === "task")?.[1];
    if (id && /^[0-9a-f]{64}$/.test(id)) ids.add(id);
  }
  return [...ids].sort();
}

/** What an item is, in two or three words, for its card. */
export function itemLabel(item: FeedItem): string {
  switch (item.kind) {
    case "goal":
      return item.state === "reached"
        ? "Goal reached"
        : item.state === "missed"
          ? "Goal missed"
          : "Goal changed";
    case "work":
      return "Work accepted";
    case "update":
      return item.help ? "Help wanted" : "Update";
  }
}

/** "2 kept, 1 missed, 1 changed" for the answers an update gives, leaving out what there is none of. Null for none. */
export function answersLine(answers: UpdateItem["answers"]): string | null {
  const parts = [
    answers.kept > 0 ? `${answers.kept} kept` : null,
    answers.missed > 0 ? `${answers.missed} missed` : null,
    answers.changed > 0 ? `${answers.changed} changed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Promises: ${parts.join(", ")}` : null;
}
