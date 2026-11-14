/**
 * Setting up Shares for one's own project (an idea: a project with no Shares yet): its name and sentence fill the
 * form, and the project made carries on under the same id, so its page, goal, updates, record and followers stay with
 * it. (Before this, the project made was a second record, and the founder was asked to take the first one down.)
 *
 * The project's page hands these words over in this browser's storage (one entry, for the server and account it was
 * made on), so the start form's link stays the same plain `/start/contributor`. It is kept until the project is made
 * or the founder says they want a separate project: a reload, or a tab closed half way, must not turn "set up Shares
 * for this project" into "make a second project". Nothing is written to the network here.
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
  /** The server the project is on. A hand-off is only ever read back on the same server. */
  server?: string;
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
        ...(idea.server ? { server: idea.server } : {}),
      }),
    );
  } catch {
    // Storage refused: nothing to carry over.
  }
}

/**
 * The idea handed over for this founder, or null. Only the idea's own author gets it: someone else's idea never fills
 * this person's form. Reading leaves the entry in place; the page clears it once the project is made.
 */
export function peekIdea(
  store: HandoffStore | null | undefined,
  me: string | null,
  /** The server the form is on. When given, a hand-off made on another server is not this form's. */
  server?: string,
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
    const from = (value as Record<string, unknown>).server;
    if (server !== undefined && from !== server) return null;
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
      ...(typeof from === "string" ? { server: from } : {}),
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

/**
 * Why Shares cannot be set up for the project handed over, or null when they can. `own` is what a direct read of the
 * founder's own record answered: the record's facts, or null when the server has no such record. When this says no,
 * nothing is made: a project asked to carry on never quietly becomes a second project under another id.
 */
export function carryOnIssue(input: {
  name: string;
  own: { isIdea: boolean } | null;
  /** The project's id was once removed from the list by this founder. */
  everRemoved: boolean;
}): string | null {
  const { name } = input;
  const separate =
    'To make another project instead, press "Start a separate project".';
  if (input.own === null)
    return `${name} is no longer on this server, so Shares can't be set up for it. Nothing was made. ${separate}`;
  if (!input.own.isIdea)
    return `${name} already has Shares or a sale set up. Nothing was made. ${separate}`;
  if (input.everRemoved)
    return `${name} has the same id as a project you removed earlier, so Shares can't be set up under it. Nothing was made. ${separate}`;
  return null;
}

/** Said when the record step could not read what the founder already has under the project's id. */
export const RECORD_UNREAD_MESSAGE =
  "Couldn't read your project's page from the server, so it was not published: publishing without it could drop its cover and rooms. Your project itself is made. Try again.";

/**
 * The record to publish for a project, starting from the founder's own record with that id as the server has it now.
 *
 * `readOwn` asks the server directly, when the record is about to be published: not a remembered list, which may be
 * old, cut short or not read yet. Whatever own record is there is carried over (its cover, topic, story and rooms),
 * whether it is the project without Shares being carried on or this same project published a moment ago by a try
 * whose answer was lost. When the read fails nothing is returned and the step fails with a way to try again:
 * publishing blind would wipe those parts for good.
 */
export async function recordCarryingOver<
  I extends { chat?: KeptFromIdea["chat"] },
>(
  input: I,
  readOwn: () => Promise<Parameters<typeof keptFromIdea>[0] | null>,
): Promise<I & KeptFromIdea> {
  let own: Awaited<ReturnType<typeof readOwn>>;
  try {
    own = await readOwn();
  } catch {
    throw new Error(RECORD_UNREAD_MESSAGE);
  }
  const kept = own ? keptFromIdea(own) : {};
  const chat = input.chat ?? kept.chat;
  return { ...kept, ...input, ...(chat ? { chat } : {}) };
}

/**
 * The project handed over for this founder on this server, looked for where it is kept now and, once, where it was
 * kept before (`earlier`, the visit's own storage, with no server on it). One found there is moved over, so a hand-off
 * made just before the app was updated still carries on the same project instead of being forgotten.
 */
export function takeHandoff(
  store: HandoffStore | null | undefined,
  earlier: HandoffStore | null | undefined,
  me: string | null,
  server: string,
): IdeaHandoff | null {
  const kept = peekIdea(store, me, server);
  if (kept) return kept;
  const old = peekIdea(earlier, me);
  // One made on another server (it says so) is not this form's.
  if (!old || (old.server !== undefined && old.server !== server)) return null;
  const moved = { ...old, server };
  handOffIdea(store, moved);
  clearIdea(earlier);
  return moved;
}

/**
 * Whether a finished job's project is the one handed over: only then is the hand-off done with. A job finished earlier
 * and still on screen must not clear a newer hand-off for another project.
 */
export function handoffFinishedBy(
  handoff: Pick<IdeaHandoff, "id"> | null,
  job: { launchId: string } | null,
): boolean {
  return handoff !== null && job !== null && handoff.id === job.launchId;
}
