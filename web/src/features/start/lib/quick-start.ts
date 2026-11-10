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
import {
  type GoalInput,
  goalProblem,
  newGoalId,
} from "../../launchpad/lib/goals.ts";

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

/** Why the project cannot be started yet and which answer it is about, or null when it can: the first in the form's order. */
export function quickStartProblem(
  draft: QuickStartDraft,
): { field: keyof QuickStartDraft; message: string } | null {
  const project = ideaIssue({ name: draft.name, pitch: draft.pitch });
  if (project) {
    // The shared check speaks of an idea; here it is a project. It checks the name first, then the sentence.
    const aboutName = ideaIssue({
      name: draft.name,
      pitch: "long enough to pass",
    });
    return aboutName
      ? {
          field: "name",
          message:
            aboutName === "Give your idea a name."
              ? "Give your project a name."
              : aboutName,
        }
      : { field: "pitch", message: project };
  }
  const goal = goalProblem(quickStartGoal(draft, "g"));
  return goal
    ? { field: goal.field === "how" ? "how" : "goal", message: goal.message }
    : null;
}

/** {@link quickStartProblem}'s words alone. */
export function quickStartIssue(draft: QuickStartDraft): string | null {
  return quickStartProblem(draft)?.message ?? null;
}

/**
 * Whether something just published can be read back, asked a few times with a pause between. A server may take a
 * moment to show a new record; the page that opens next should find it there. Bounded: after the last try it answers
 * false and the caller says so, instead of waiting for ever. A read that fails counts as "not yet".
 */
export async function readableSoon(
  read: () => Promise<boolean>,
  options: {
    tries?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const tries = options.tries ?? 5;
  const waitMs = options.waitMs ?? 600;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      if (await read()) return true;
    } catch {
      // Not readable yet.
    }
    if (attempt < tries - 1) await sleep(waitMs);
  }
  return false;
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

/** The project this visit made whose goal is still to be saved, and the id that goal will have. */
export interface MadeProject {
  id: string;
  author: string;
  /**
   * The goal's id, fixed when the project was made. A retry, even after a reload, sends the same goal again; with a
   * new id each time, a send whose answer was lost would leave the project with two main goals.
   */
  goalId: string;
}

/**
 * The project made earlier in this visit by `me`, whose goal was not saved yet, or null. Kept so a reload between the
 * two sends carries on with the goal instead of making a second project.
 */
export function loadMadeProject(
  store: DraftStore | null | undefined,
  me: string | null,
  /** Makes a goal id for an entry kept before goal ids were stored with it. */
  mint: () => string = newGoalId,
): MadeProject | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(MADE_KEY) ?? "null");
    if (!value || typeof value !== "object" || me === null) return null;
    const { id, author, goalId } = value as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || author !== me) return null;
    if (typeof goalId === "string" && goalId !== "")
      return { id, author: me, goalId };
    // Kept before the goal's id was stored with it. The project is still the one to carry on (dropping the entry
    // would make a second project on the next press); it is given a goal id now, kept so a later retry sends the same.
    const made = { id, author: me, goalId: mint() };
    saveMadeProject(store, made);
    return made;
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

const ATTEMPT_KEY = "creaton.start.quick.attempt";

/** The id a press of Start was about to publish a project under. */
export interface StartAttempt {
  id: string;
  author: string;
}

/**
 * The id the last press tried to publish under, for `me`, or null. Kept before anything is sent: a publish can land
 * on the server while its answer is lost, and the next press must then find that project and carry on with it, not
 * see its id as taken and make a second project beside it.
 */
export function loadStartAttempt(
  store: DraftStore | null | undefined,
  me: string | null,
): StartAttempt | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(ATTEMPT_KEY) ?? "null");
    if (!value || typeof value !== "object" || me === null) return null;
    const { id, author } = value as Record<string, unknown>;
    return typeof id === "string" && id !== "" && author === me
      ? { id, author: me }
      : null;
  } catch {
    return null;
  }
}

export function saveStartAttempt(
  store: DraftStore | null | undefined,
  attempt: StartAttempt | null,
): void {
  try {
    if (attempt) store?.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
    else store?.removeItem(ATTEMPT_KEY);
  } catch {
    // Storage refused: a lost answer could not be told from a clash, so the next press takes a new id.
  }
}

/**
 * What a press of Start does about the project itself, given the id an earlier press tried (if any) and whether the
 * person already has a record under an id.
 *
 * - An earlier press tried an id and a record is there under it: that press landed. Carry on with that project.
 * - Otherwise a new project is published under a fresh id from `fresh`, which is given the ids to avoid.
 */
export async function projectToStart(input: {
  attempt: StartAttempt | null;
  /** Whether the person has a record under this id, asked of the server. Throws when that cannot be read. */
  hasOwn: (id: string) => Promise<boolean>;
  /** A fresh id that is none of `taken`. */
  fresh: (taken: readonly string[]) => string;
  /** The person's own ids, as read. */
  mine: readonly string[];
}): Promise<{ id: string; adopt: boolean }> {
  const { attempt, hasOwn, fresh, mine } = input;
  // Nothing there under the earlier press's id: that press did not land, and this one starts afresh (the same name
  // gives the same id again; a changed name gets its own).
  if (attempt && (await hasOwn(attempt.id)))
    return { id: attempt.id, adopt: true };
  const taken = [...mine];
  let id = fresh(taken);
  // Asked once more, by id, just before publishing: a project made a moment ago elsewhere is not replaced.
  if (await hasOwn(id)) {
    taken.push(id);
    id = fresh(taken);
  }
  return { id, adopt: false };
}
