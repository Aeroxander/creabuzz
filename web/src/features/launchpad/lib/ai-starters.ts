/**
 * Starter wording for an AI project's first week, offered where the founder writes: three first promises in the first
 * weekly update's "What's next", and starter tasks where a task is made.
 *
 * The kind picked on Start (AI app, agent or tool, dataset or benchmark, AI media) is not kept on the project's record,
 * only its category is. So the project page cannot know the kind: it offers all four by name, on a project whose
 * category says it is about AI work, and the founder presses the one that fits. A press only fills a box. Nothing is
 * signed or sent until the founder edits the words, or leaves them, and publishes; the record's shape is unchanged.
 *
 * Pure and alias-free: `ai-starters.test.mjs` drives it under `node --test`.
 */

import { AI_PROJECT_KINDS } from "@creaton/core/launchpad/aiProjectKinds.ts";

import { isAiCategory } from "./agent-post.ts";

/** One kind's starter wording, as the pages offer it. */
export interface AiStarterKind {
  id: string;
  label: string;
  /** The three first promises, one per line: what "What's next" is filled with. */
  promises: string;
  tasks: readonly { title: string; done: string }[];
}

const STARTERS: readonly AiStarterKind[] = AI_PROJECT_KINDS.map((kind) => ({
  id: kind.id,
  label: kind.label,
  promises: kind.promises.join("\n"),
  tasks: kind.tasks,
}));

/** The kinds whose starter wording a project is offered: all of them for an AI project, none for any other. */
export function aiStarterKinds(
  category: string | null | undefined,
): readonly AiStarterKind[] {
  return isAiCategory(category) ? STARTERS : [];
}

/**
 * The kinds whose first promises the update dialog offers: only on an AI project's FIRST weekly update. `weeklyPosted`
 * is how many weekly updates the team has posted, or null while that is not known (nothing is offered on a guess).
 */
export function starterPromiseKinds(input: {
  category: string | null | undefined;
  weeklyPosted: number | null;
}): readonly AiStarterKind[] {
  return input.weeklyPosted === 0 ? aiStarterKinds(input.category) : [];
}

/**
 * Whether a box may still be filled by a press: it is empty, or holds starter wording nobody has edited. Words the
 * founder wrote are never replaced.
 */
export function replaceableByStarter(
  written: string,
  starters: readonly string[],
): boolean {
  const text = written.trim();
  return text === "" || starters.some((starter) => starter.trim() === text);
}

/** What a press on a kind leaves in "What's next": its promises, or nothing when it was already the one pressed. */
export function pressStarterPromises(
  next: string,
  kind: AiStarterKind,
): string {
  return next.trim() === kind.promises ? "" : kind.promises;
}

/**
 * The starter tasks still worth offering: a kind's tasks without the ones the project already made (by their words).
 */
export function starterTasksLeft(
  kind: AiStarterKind,
  made: readonly string[],
): readonly { title: string; done: string }[] {
  const have = new Set(made.map((what) => what.trim().toLowerCase()));
  return kind.tasks.filter((task) => !have.has(task.title.toLowerCase()));
}
