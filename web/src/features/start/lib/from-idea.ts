/**
 * Starting a contributor project from one's own idea: the idea's name and sentence fill the form, and once the project
 * is made the founder is offered to take the idea off Discover, so the same project is not listed twice under two
 * kinds of record.
 *
 * The idea's page hands these words over in this browser's session storage (one entry), so the start form's
 * link stays the same plain `/start/contributor`. The form clears it once read. Nothing is written to the network here.
 *
 * Pure and alias-free: `from-idea.test.mjs` drives it under `node --test`.
 */

import { NAME_MAX, PITCH_MAX } from "./contributor-project.ts";

const KEY = "creaton.start.from-idea";

/** The idea a contributor project is being started from. */
export interface IdeaHandoff {
  /** The idea's launch id and its author: the founder of both. */
  id: string;
  author: string;
  name: string;
  pitch: string;
}

/** The slice of storage this reads and writes (session storage in the app, a map in tests). */
export interface HandoffStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Keep the idea for the start form. A refused write only means the form starts empty. */
export function handOffIdea(
  store: HandoffStore | null | undefined,
  idea: IdeaHandoff,
): void {
  try {
    store?.setItem(
      KEY,
      JSON.stringify({
        id: idea.id,
        author: idea.author,
        name: idea.name.slice(0, NAME_MAX),
        pitch: idea.pitch.slice(0, PITCH_MAX),
      }),
    );
  } catch {
    // Storage refused: nothing to carry over.
  }
}

/**
 * The idea handed over for this founder, or null. Only the idea's own author gets it: someone else's idea never fills
 * this person's form. Reading leaves the entry in place (a render may run twice); the page clears it once it has it.
 */
export function peekIdea(
  store: HandoffStore | null | undefined,
  me: string | null,
): IdeaHandoff | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw || !me) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { id, author, name, pitch } = value as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof author !== "string" ||
      typeof name !== "string" ||
      typeof pitch !== "string" ||
      id === "" ||
      author !== me
    )
      return null;
    return {
      id,
      author,
      name: name.slice(0, NAME_MAX),
      pitch: pitch.slice(0, PITCH_MAX),
    };
  } catch {
    return null;
  }
}

/** Forget the handed-over idea, so a later visit to the form starts empty. */
export function clearIdea(store: HandoffStore | null | undefined): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
