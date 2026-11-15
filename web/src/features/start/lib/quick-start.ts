/**
 * Starting a project with three answers: its name, the goal, and how everyone will know it was reached.
 *
 * Nothing else is required. The one-sentence line that sits under the name on the project's page is the goal's first
 * 140 characters unless the founder edits it, and a kind of project is an optional chip (`launchpad/lib/categories.ts`). The project made is the lightest kind there is: a public page with no Shares, no money, no
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

import { IDEA_PITCH_MAX, ideaIssue } from "../../launchpad/lib/idea.ts";
import { startCategory } from "../../launchpad/lib/categories.ts";
import {
  type GoalInput,
  goalProblem,
  newGoalId,
} from "../../launchpad/lib/goals.ts";

export interface QuickStartDraft {
  name: string;
  /** The one-liner as the founder edited it. Empty means "use the goal's first words" ({@link quickStartPitch}). */
  pitch: string;
  goal: string;
  how: string;
  /** One of the fixed categories, or empty for none. */
  category: string;
  /** The kind of AI project whose starter wording was picked (`aiProjectKinds.ts`), or empty. Never sent anywhere. */
  kind: string;
}

export const EMPTY_QUICK_START: QuickStartDraft = {
  name: "",
  pitch: "",
  goal: "",
  how: "",
  category: "",
  kind: "",
};

/**
 * The one-liner the project is made with: what the founder wrote, or else the goal's first 140 characters (the most a
 * one-liner holds), so the form needs no separate sentence.
 */
export function quickStartPitch(
  draft: Pick<QuickStartDraft, "pitch" | "goal">,
): string {
  const own = draft.pitch.trim();
  return own !== "" ? own : draft.goal.trim().slice(0, IDEA_PITCH_MAX).trim();
}

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

/** The answers the form can point at when one is missing or wrong. */
export type QuickStartField = "name" | "pitch" | "goal" | "how";

/** Why the project cannot be started yet and which answer it is about, or null when it can: the first in the form's order. */
export function quickStartProblem(
  draft: QuickStartDraft,
): { field: QuickStartField; message: string } | null {
  const pitch = quickStartPitch(draft);
  const project = ideaIssue({ name: draft.name, pitch });
  if (project) {
    // The shared check speaks of an idea; here it is a project. It checks the name first, then the sentence.
    const aboutName = ideaIssue({
      name: draft.name,
      pitch: "long enough to pass",
    });
    if (aboutName)
      return {
        field: "name",
        message:
          aboutName === "Give your idea a name."
            ? "Give your project a name."
            : aboutName,
      };
    // Nobody wrote a one-liner, so a short one comes from a short goal: point at the goal, not at a box they never saw.
    if (draft.pitch.trim() === "") {
      return {
        field: "goal",
        message:
          draft.goal.trim().length < 3
            ? "Say what the goal is."
            : "Say the goal in a sentence.",
      };
    }
    return { field: "pitch", message: project };
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
      category: startCategory(raw.category),
      kind: typeof raw.kind === "string" ? raw.kind.slice(0, 40) : "",
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

/** A tap-to-fill example for "How we'll know": what it is called on the chip, and the sentence it fills in. */
interface HowExample {
  id: string;
  label: string;
  text: string;
}

/** Three plain ways to say how we will know. Each is a sentence to edit, not a rule. */
export const HOW_EXAMPLES: readonly HowExample[] = [
  {
    id: "number",
    label: "A number by a date",
    text: "At least 10 people use it by the end of next month.",
  },
  {
    id: "link",
    label: "A link people can open",
    text: "A page anyone can open at a link, with the first version working.",
  },
  {
    id: "person",
    label: "A named person confirms",
    text: "The person I name here confirms in writing that it is done.",
  },
];

/**
 * What a box holds after someone taps a suggestion chip. An empty box, or one still holding another suggestion, is
 * replaced; a box with the person's own words keeps them and gets the suggestion on a new line, so a tap never throws
 * away what was typed. Cut at `max`, the box's own limit.
 */
export function applySuggestion(
  current: string,
  suggestion: string,
  known: readonly string[],
  max: number,
): string {
  const text = current.trim();
  const next =
    text === "" || known.includes(text) ? suggestion : `${text}\n${suggestion}`;
  return next.slice(0, max);
}

const AFTER_SIGN_UP_KEY = "creaton.start.quick.after-sign-up";

/** How long a press of Start that is waiting for an account stays good: after that the person presses it again. */
const AFTER_SIGN_UP_MS = 15 * 60_000;

/**
 * Remember that Start was pressed while signed out, so the project is made as soon as the account exists, with no
 * second press. Sign-up may reload the page, so this lives in session storage next to the draft it belongs to.
 */
export function markStartAfterSignUp(
  store: DraftStore | null | undefined,
  now: number = Date.now(),
): void {
  try {
    store?.setItem(AFTER_SIGN_UP_KEY, String(now));
  } catch {
    // Storage refused: the person presses Start again once signed up.
  }
}

/** Whether Start is waiting for an account, without using it up. */
export function startAfterSignUpWaiting(
  store: DraftStore | null | undefined,
  now: number = Date.now(),
): boolean {
  try {
    const at = Number(store?.getItem(AFTER_SIGN_UP_KEY) ?? "");
    return Number.isFinite(at) && at > 0 && now - at <= AFTER_SIGN_UP_MS;
  } catch {
    return false;
  }
}

/**
 * Whether Start was waiting for an account, and forget that: it answers true once per press, so the project is made
 * once however many times the page re-renders or the account is announced. An old mark is forgotten and answers false.
 */
export function takeStartAfterSignUp(
  store: DraftStore | null | undefined,
  now: number = Date.now(),
): boolean {
  const waiting = startAfterSignUpWaiting(store, now);
  clearStartAfterSignUp(store);
  return waiting;
}

/** Forget a waiting press (the person changed the form, or pressed Start themselves). */
export function clearStartAfterSignUp(
  store: DraftStore | null | undefined,
): void {
  try {
    store?.removeItem(AFTER_SIGN_UP_KEY);
  } catch {
    // Storage refused: nothing to forget.
  }
}
