/**
 * A task row's content, both ways: what a new task or the next version of one writes (`newTaskRow`, `taskUpdateRow`,
 * `patchTask`), and what reading a row gives back (`parseTask`). The hooks sign, send and subscribe; every field a row
 * carries is decided here, so a field wired on one side and dropped on the other fails `task-row.test.mjs`.
 *
 * Pure and alias-free: `task-row.test.mjs` drives it under `node --test`.
 */

import {
  readDelivery,
  type TaskDelivery,
  taskDeliveryTags,
} from "./task-delivery.ts";
import { readPartOf, type TaskPartOf, taskPartOfTags } from "./task-part-of.ts";
import { readMilestone, readReward } from "./task-planning.ts";
import { readSource, type TaskSource } from "./task-source.ts";

type TaskStatus =
  | "open"
  | "assigned"
  | "in_progress"
  | "needs_approval"
  | "done"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface FleetTask {
  /** Raw `d` tag: the task's identity on the relay, used when publishing. */
  id: string;
  /** Author-qualified key (`author:id`) for storing, keying and de-duplicating. */
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  parentEventId: string | null;
  channelId: string | null;
  author: string;
  priority: TaskPriority;
  due: number | null;
  labels: string[];
  /** Milestone this task counts toward (free text), or null. */
  milestone: string | null;
  /** Points the task earns once its contribution is accepted, or null. */
  reward: number | null;
  /** The board post this task was made from, or null. */
  source: TaskSource | null;
  /** Project/output/claim references; these do not authorize any payment. */
  delivery?: TaskDelivery | null;
  /** The work area of a contributor project this task is part of; a reference that awards nothing. */
  partOf?: TaskPartOf | null;
  approver?: string | null;
  updatedAt: number;
}

/** What a person fills in to create a task. */
export interface NewTaskInput {
  /** A fixed task id, so sending the same task twice writes one task, not two. */
  id?: string;
  title: string;
  description?: string;
  assignee?: string;
  channelId?: string;
  parentEventId?: string;
  priority?: TaskPriority;
  due?: number | null;
  labels?: string[];
  /** Left out of the row when undefined; `null` writes an explicit "none". */
  milestone?: string | null;
  reward?: number | null;
  /** The board post this task was made from. */
  source?: TaskSource;
  /** The contributor project's work area this task is part of. */
  partOf?: TaskPartOf | null;
}

/** The fields of a task an edit may change; `undefined` keeps the task's own value, `null` clears it. */
export interface TaskPatch {
  description?: string;
  priority?: TaskPriority;
  due?: number | null;
  labels?: string[];
  title?: string;
  milestone?: string | null;
  reward?: number | null;
  delivery?: TaskDelivery | null;
  partOf?: TaskPartOf | null;
}

/** A row ready to sign: its tags and its content. */
export interface TaskRow {
  tags: string[][];
  body: Record<string, unknown>;
}

/** The row's tags with the index tags its content asks for (a delivery's and a "Part of" link's project). */
export function taskRowTags(
  tags: string[][],
  body: Record<string, unknown>,
): string[][] {
  return taskPartOfTags(taskDeliveryTags(tags, body.delivery), body.partOf);
}

/** The first row of a new task with id `id`: assigned when it names an assignee, open otherwise. */
export function newTaskRow(input: NewTaskInput, id: string): TaskRow {
  const tags: string[][] = [["d", id]];
  if (input.assignee) tags.push(["p", input.assignee]);
  if (input.parentEventId) tags.push(["e", input.parentEventId]);
  if (input.channelId) tags.push(["h", input.channelId]);
  return {
    tags,
    body: {
      title: input.title,
      description: input.description ?? "",
      status: input.assignee ? "assigned" : "open",
      priority: input.priority ?? "normal",
      due: input.due ?? null,
      labels: input.labels ?? [],
      ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
      ...(input.reward !== undefined ? { reward: input.reward } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.partOf ? { partOf: input.partOf } : {}),
    },
  };
}

/** The next row of `task`, with `status` and `approver`: every planning field written again, so none is lost. */
export function taskUpdateRow(
  task: FleetTask,
  status: string,
  approver: string | null,
): TaskRow {
  const tags: string[][] = [
    ["d", task.id],
    ["p", task.assignee ?? approver ?? task.author],
  ];
  if (task.channelId) tags.push(["h", task.channelId]);
  if (task.parentEventId) tags.push(["e", task.parentEventId]);
  return {
    tags,
    body: {
      title: task.title,
      description: task.description,
      status,
      approver,
      priority: task.priority,
      due: task.due,
      labels: task.labels,
      milestone: task.milestone,
      reward: task.reward,
      delivery: task.delivery ?? null,
      partOf: task.partOf ?? null,
      _taskId: task.id,
    },
  };
}

/** `task` with an edit applied. */
export function patchTask(task: FleetTask, patch: TaskPatch): FleetTask {
  return {
    ...task,
    title: patch.title ?? task.title,
    description: patch.description ?? task.description,
    priority: patch.priority ?? task.priority,
    due: patch.due !== undefined ? patch.due : task.due,
    labels: patch.labels !== undefined ? patch.labels : task.labels,
    milestone: patch.milestone !== undefined ? patch.milestone : task.milestone,
    reward: patch.reward !== undefined ? patch.reward : task.reward,
    delivery: patch.delivery !== undefined ? patch.delivery : task.delivery,
    partOf: patch.partOf !== undefined ? patch.partOf : task.partOf,
  };
}

const STATUSES: readonly TaskStatus[] = [
  "open",
  "assigned",
  "in_progress",
  "needs_approval",
  "done",
  "cancelled",
];
const PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "urgent"];

/** A task from one row (for a merged task, `mergeTaskRows`' event), or null when the row has no `d` tag. */
export function parseTask<
  // A whole event may be passed; only these fields are read.
  E extends {
    pubkey: string;
    created_at: number;
    tags: string[][];
    content: string;
  },
>(event: E): FleetTask | null {
  const id = event.tags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;
  let body: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    due?: number | null;
    labels?: string[];
    milestone?: unknown;
    reward?: unknown;
    source?: unknown;
    delivery?: unknown;
    partOf?: unknown;
    approver?: unknown;
  } = {};
  try {
    body = JSON.parse(event.content) as typeof body;
  } catch {
    // malformed content — task still surfaces with defaults
  }
  if (body === null || typeof body !== "object") body = {};
  const status = STATUSES.includes(body.status as TaskStatus)
    ? (body.status as TaskStatus)
    : "open";
  return {
    id,
    key: `${event.pubkey}:${id}`,
    title: body.title ?? event.content.slice(0, 80),
    description: body.description ?? "",
    status,
    assignee: event.tags.find((t) => t[0] === "p")?.[1] ?? null,
    parentEventId: event.tags.find((t) => t[0] === "e")?.[1] ?? null,
    channelId: event.tags.find((t) => t[0] === "h")?.[1] ?? null,
    author: event.pubkey,
    priority: PRIORITIES.includes(body.priority as TaskPriority)
      ? (body.priority as TaskPriority)
      : "normal",
    due: typeof body.due === "number" && body.due > 0 ? body.due : null,
    labels: Array.isArray(body.labels) ? body.labels : [],
    milestone: readMilestone(body.milestone),
    reward: readReward(body.reward),
    source: readSource(body.source),
    delivery: readDelivery(body.delivery),
    partOf: readPartOf(body.partOf),
    approver: typeof body.approver === "string" ? body.approver : null,
    updatedAt: event.created_at * 1000,
  };
}
