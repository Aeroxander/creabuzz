/**
 * Starting a project with four answers: its name, one sentence, the goal, and how everyone will know it was reached.
 *
 * Nothing else is asked. The project made is the lightest kind there is: a public page with no Shares, no money, no
 * reviewers and nothing sent to the network. Everything else has a default or is set up later from the project page.
 *
 * Two records are published, in this order: the project, then its goal. If the second does not go through the project
 * exists without a goal, which is a state the project page already handles (its founder is asked to set one); the form
 * also stays as it was and tries the goal again on its own, never the project a second time.
 *
 * What is typed is kept for this visit (session storage), so signing up or a failed send does not lose it.
 *
 * Pure and alias-free: `quick-start.test.mjs` drives it under `node --test`.
 */

import { ideaIssue } from "../../launchpad/lib/idea.ts";
import { goalIssue, type GoalInput } from "../../launchpad/lib/goals.ts";

export interface QuickStartDraft {
  name: string;
  pitch: string;
  goal: string;
  how: string;
}

export const EMPTY_QUICK_START: QuickStartDraft = {
  name: "",
  pitch: "",
  goal: "",
  how: "",
};

/** The project's first goal, as its goal record. */
export function quickStartGoal(
  draft: QuickStartDraft,
  goalId: string,
): GoalInput {
  return {
    id: goalId,
    level: "primary",
    text: draft.goal,
    how: draft.how,
    state: "open",
    reason: "",
  };
}

/** Why the project cannot be started yet, or null when it can. The first thing missing, in the form's order. */
export function quickStartIssue(draft: QuickStartDraft): string | null {
  const project = ideaIssue({ name: draft.name, pitch: draft.pitch });
  if (project)
    // The shared check speaks of an idea; here it is a project.
    return project === "Give your idea a name."
      ? "Give your project a name."
      : project;
  return goalIssue(quickStartGoal(draft, "g"));
}

const KEY = "creaton.start.quick";

interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What was typed earlier in this visit, or an empty form. */
export function loadQuickStart(
  store: DraftStore | null | undefined,
): QuickStartDraft {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return EMPTY_QUICK_START;
    const raw = value as Record<string, unknown>;
    const text = (field: unknown) =>
      typeof field === "string" ? field.slice(0, 300) : "";
    return {
      name: text(raw.name),
      pitch: text(raw.pitch),
      goal: text(raw.goal),
      how: text(raw.how),
    };
  } catch {
    return EMPTY_QUICK_START;
  }
}

/** Keep what is typed for this visit. A refused write only means a reload starts empty. */
export function saveQuickStart(
  store: DraftStore | null | undefined,
  draft: QuickStartDraft | null,
): void {
  try {
    if (draft) store?.setItem(KEY, JSON.stringify(draft));
    else store?.removeItem(KEY);
  } catch {
    // Storage refused: nothing kept.
  }
}

const MADE_KEY = "creaton.start.quick.made";

/** The project this visit made whose goal is still to be saved. */
export interface MadeProject {
  id: string;
  author: string;
}

/**
 * The project made earlier in this visit by `me`, whose goal was not saved yet, or null. Kept so a reload between the
 * two sends carries on with the goal instead of making a second project.
 */
export function loadMadeProject(
  store: DraftStore | null | undefined,
  me: string | null,
): MadeProject | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(MADE_KEY) ?? "null");
    if (!value || typeof value !== "object" || me === null) return null;
    const { id, author } = value as Record<string, unknown>;
    return typeof id === "string" && id !== "" && author === me
      ? { id, author: me }
      : null;
  } catch {
    return null;
  }
}

/** Remember the project made (or forget it, once its goal is saved). */
export function saveMadeProject(
  store: DraftStore | null | undefined,
  made: MadeProject | null,
): void {
  try {
    if (made) store?.setItem(MADE_KEY, JSON.stringify(made));
    else store?.removeItem(MADE_KEY);
  } catch {
    // Storage refused: a reload would start a new project instead of carrying on.
  }
}
