/**
 * A task that began as a suggestion on a board, and the credit its finder earns.
 *
 * The team turns a board post into a task (`taskFromPost`). The task keeps a
 * `source` that names the post, its board and the person who wrote it, so the
 * link survives every later edit (it is a sticky task field, see
 * `TASK_STICKY_FIELDS`). When the task is finished, the person who wrote the
 * post can file a *finder's credit*: an ordinary pending contribution record,
 * keyed apart from the task's own, that a reviewer accepts or rejects like any
 * other. Nothing is paid by this file; points are credit, not a balance.
 *
 * What keeps it from being farmed:
 * - you cannot turn your own post into a task, so credit always passes through
 *   a second person;
 * - the credit can only be claimed once the task is done, and only by the
 *   author the post really has (the app checks the post itself before filing);
 * - it is one record per finished task, so a second claim is refused;
 * - a reviewer still decides, and sees the post and the finished task.
 *
 * Pure and alias-free: `task-source.test.mjs` drives it under `node --test`.
 */

import { KIND_CONTRIBUTION, KIND_TASK, readReward } from "./task-planning.ts";

/** Where a task came from: a post on a board. */
export interface TaskSource {
  /** Event id of the board post. */
  post: string;
  /** The board it was written on (its channel id). */
  board: string;
  /** Public key of the person who wrote the post: the finder. */
  author: string;
  /** Points the finder earns once the task is done and the credit accepted. */
  finderReward: number | null;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** The share of a task's reward offered to the person who suggested it. */
const FINDER_SHARE = 0.1;

/** A well-formed source, or null. Keys are lower-cased, so they compare. */
export function readSource(value: unknown): TaskSource | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const post = typeof raw.post === "string" ? raw.post.toLowerCase() : "";
  const author = typeof raw.author === "string" ? raw.author.toLowerCase() : "";
  const board = typeof raw.board === "string" ? raw.board.trim() : "";
  if (!HEX_64.test(post) || !HEX_64.test(author) || board === "") return null;
  return {
    post,
    board: board.slice(0, 120),
    author,
    finderReward: readReward(raw.finderReward),
  };
}

/**
 * What a finder is offered when the team sets no figure of its own: a tenth of
 * the task's reward, at least one point. A task with no reward offers nothing.
 */
export function defaultFinderReward(reward: number | null): number | null {
  if (reward === null || reward <= 0) return null;
  return Math.max(1, Math.round(reward * FINDER_SHARE));
}

/** A whole number of points from a text box, or null when it is empty or not one. */
function points(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * The points a task made from a board post carries: the reward and the finder's credit as typed (the finder's a tenth
 * of the reward when left empty, `finderText` null). A build without raises (the pilot) offers no points at all: no
 * screen there accepts them, and Shares come only from a project's own work areas.
 */
export function escalationPoints(
  raises: boolean,
  rewardText: string,
  finderText: string | null,
): { reward: number | null; finderReward: number | null } {
  if (!raises) return { reward: null, finderReward: null };
  const reward = points(rewardText);
  return {
    reward,
    finderReward:
      finderText === null ? defaultFinderReward(reward) : points(finderText),
  };
}

/** Whether `viewer` may turn a post by `postAuthor` into a task. */
export function canEscalatePost(
  postAuthor: string,
  viewer: string | null,
): boolean {
  if (!viewer) return false;
  return viewer.toLowerCase() !== postAuthor.toLowerCase();
}

/** A task as the board shows it, reduced to what a finder's claim depends on. */
export interface SourcedTask {
  source: TaskSource | null;
  /** Row that marked the task done, while it is done. */
  doneRowId: string | null;
}

/**
 * Whether `viewer` may now file the finder's credit for `task`: the task is
 * finished, it began as their own post, and a figure was offered.
 */
export function canClaimFinderCredit(
  task: SourcedTask,
  viewer: string | null,
): boolean {
  if (!viewer || !task.source || !task.doneRowId) return false;
  if (task.source.finderReward === null) return false;
  return task.source.author === viewer.toLowerCase();
}

/**
 * The key a finder's credit uses, apart from the task's own record. It stays
 * inside the 64 bytes the record builders allow an id (a reviewer's tools
 * rebuild the record under the same key), so it keeps the first 56 characters
 * of the done row's id: 224 bits, which cannot collide in practice.
 */
export function finderCreditKey(doneRowId: string): string {
  return `finder:${doneRowId.slice(0, 56)}`;
}

/** The task a team member creates from a board post. */
export function taskFromPost(input: {
  post: { id: string; author: string; title: string; body: string };
  board: string;
  reward: number | null;
  finderReward: number | null;
  milestone: string | null;
}): {
  title: string;
  description: string;
  channelId: string;
  labels: string[];
  milestone: string | null;
  reward: number | null;
  source: TaskSource;
} {
  const title = input.post.title.trim().slice(0, 200);
  return {
    title: title === "" ? "Suggestion from the board" : title,
    description: input.post.body.trim().slice(0, 2000),
    channelId: input.board,
    labels: ["from-board"],
    milestone: input.milestone,
    reward: input.reward,
    source: {
      post: input.post.id.toLowerCase(),
      board: input.board,
      author: input.post.author.toLowerCase(),
      finderReward: input.finderReward,
    },
  };
}

/** The line left under the post, so its author sees what became of it. */
export function escalationNote(input: { finderReward: number | null }): string {
  const credit =
    input.finderReward === null
      ? ""
      : ` If it gets done, you can claim ${input.finderReward} ${
          input.finderReward === 1 ? "point" : "points"
        } as its finder.`;
  return `The team turned this into a task.${credit}`;
}

/**
 * The pending contribution record (unsigned) for a finder's credit. It carries
 * the post and the finished task as evidence, so a reviewer can see both.
 */
export function buildFinderContribution(input: {
  doneRowId: string;
  source: TaskSource;
  title: string;
  milestone: string | null;
}): { kind: number; tags: string[][]; content: string } {
  const key = finderCreditKey(input.doneRowId);
  const content: Record<string, unknown> = {
    v: 1,
    action: `Suggested on the board: ${input.title.trim()}`.slice(0, 2000),
    dimensions: {},
    evidence: [input.source.post, input.doneRowId],
    humanVsAi: { human: 1, ai: 0 },
    informedBy: [input.doneRowId],
    reviewStatus: "pending",
    appealHistory: [],
  };
  if (input.source.finderReward !== null) {
    content.amount = input.source.finderReward;
  }
  if (input.milestone) content.milestone = input.milestone;
  return {
    kind: KIND_CONTRIBUTION,
    tags: [
      ["d", key],
      ["e", input.source.post],
      ["e", input.doneRowId],
      ["k", String(KIND_TASK)],
    ],
    content: JSON.stringify(content),
  };
}
