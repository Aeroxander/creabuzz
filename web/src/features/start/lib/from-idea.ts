/**
 * Setting up Shares for one's own project (an idea: a project with no Shares yet): its name and sentence fill the
 * form, and the project made carries on under the same id, so its page, goal, updates, record and followers stay with
 * it. (Before this, the project made was a second record, and the founder was asked to take the first one down.)
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

/** What a project that sets up Shares keeps of the project it carries on: its cover, topic, story and rooms. */
export interface KeptFromIdea {
  image?: string;
  category?: string;
  longPitch?: string;
  chat?: {
    team: string | null;
    supporters: string | null;
    backers: string | null;
    board: string | null;
  };
}

/**
 * The parts of a project's record that setting up Shares does not ask about, so publishing the record again over the
 * same id does not drop them. Its name and sentence come from the form; its goal, updates and record are other
 * records that name the project by id and need nothing done.
 */
export function keptFromIdea(record: {
  image: string | null;
  category: string | null;
  longPitch: string | null;
  chat: NonNullable<KeptFromIdea["chat"]>;
}): KeptFromIdea {
  return {
    ...(record.image ? { image: record.image } : {}),
    ...(record.category ? { category: record.category } : {}),
    ...(record.longPitch ? { longPitch: record.longPitch } : {}),
    chat: { ...record.chat },
  };
}
