/**
 * The promise record: what a project said it would do next, and what came of it.
 *
 * Each line of an update's "What's next" is a promise for the next update. The founder's next update answers each one:
 * done, not done, or changed, with an optional short note. Both live on the update records themselves:
 *
 *   promise        its number in that update, and its words          ["promise", "0", "Invite ten people"]
 *   promise-mark   the promise answered, the answer, a short note    ["promise-mark", "<update id>:0", "done", ""]
 *
 * A promise's id is the id of the update that made it and its number, so an answer can only ever name one promise.
 * Only the founder's updates count, on both sides. The first answer stands: a later update cannot turn "not done"
 * into "done". There is no record that takes a miss away; only deleting the update that holds it does.
 *
 * A promise the next update did not answer is not hidden. It shows as "not answered", and the next update asks again.
 *
 * Pure and alias-free: `promises.test.mjs` drives it under `node --test`.
 */

export const PROMISE_LIMITS = {
  /** One promise is one line. */
  text: 200,
  note: 140,
  /** The most promises one update makes, and the most answers it carries. */
  perUpdate: 10,
  answers: 30,
} as const;

export const MARK_STATES = ["done", "not-done", "changed"] as const;
export type MarkState = (typeof MARK_STATES)[number];

/** What the dialog's three buttons say. */
export const MARK_LABEL: Record<MarkState, string> = {
  done: "Done",
  "not-done": "Not done",
  changed: "Changed",
};

const TAG_PROMISE = "promise";
const TAG_MARK = "promise-mark";

const PROMISE_ID_RE = /^[0-9a-f]{64}:\d{1,2}$/;

type Tags = readonly (readonly string[])[];

function isMarkState(value: unknown): value is MarkState {
  return (MARK_STATES as readonly string[]).includes(value as string);
}

/**
 * The promises in a "What's next" answer: one per line, without the list marks people type ("- ", "* ", "1. "), empty
 * lines left out, each cut to a line's length, at most {@link PROMISE_LIMITS.perUpdate}.
 */
export function promiseLines(next: string): string[] {
  return next
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "")
        .slice(0, PROMISE_LIMITS.text)
        .trim(),
    )
    .filter((line) => line !== "")
    .slice(0, PROMISE_LIMITS.perUpdate);
}

/** The tags that carry an update's promises. */
export function promiseTags(next: string): string[][] {
  return promiseLines(next).map((text, index) => [
    TAG_PROMISE,
    String(index),
    text,
  ]);
}

/** One answer the founder gives in the dialog. `text` is the promise's words, for the update's readable body. */
export interface MarkDraft {
  promiseId: string;
  text: string;
  state: MarkState;
  note: string;
}

/** The tags that carry an update's answers to earlier promises. */
export function markTags(marks: readonly MarkDraft[]): string[][] {
  return marks
    .filter(
      (mark) => PROMISE_ID_RE.test(mark.promiseId) && isMarkState(mark.state),
    )
    .slice(0, PROMISE_LIMITS.answers)
    .map((mark) => [
      TAG_MARK,
      mark.promiseId,
      mark.state,
      mark.note.trim().slice(0, PROMISE_LIMITS.note),
    ]);
}

/**
 * The answers as words for the update's body, so they read in any app that shows updates:
 * "Done: Invite ten people" / "Not done: Fix the email (ran out of time)".
 */
export function marksSection(marks: readonly MarkDraft[]): string {
  const lines = marks
    .filter((mark) => isMarkState(mark.state))
    .slice(0, PROMISE_LIMITS.answers)
    .map((mark) => {
      const note = mark.note.trim().slice(0, PROMISE_LIMITS.note);
      return `${MARK_LABEL[mark.state]}: ${mark.text}${note ? ` (${note})` : ""}`;
    });
  return lines.length > 0 ? `What we said last time\n${lines.join("\n")}` : "";
}

export interface UpdatePromise {
  index: number;
  text: string;
}

export interface PromiseMark {
  promiseId: string;
  state: MarkState;
  note: string;
}

/** The promises an update's tags carry: each number once, in order. */
export function parsePromises(tags: Tags): UpdatePromise[] {
  const out = new Map<number, UpdatePromise>();
  for (const tag of tags) {
    if (tag[0] !== TAG_PROMISE || typeof tag[2] !== "string") continue;
    if (!/^\d{1,2}$/.test(tag[1] ?? "")) continue;
    const index = Number(tag[1]);
    const text = tag[2].trim().slice(0, PROMISE_LIMITS.text);
    if (text === "" || out.has(index)) continue;
    out.set(index, { index, text });
    if (out.size >= PROMISE_LIMITS.perUpdate) break;
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

/** The answers an update's tags carry: one per promise, the first one given. */
export function parseMarks(tags: Tags): PromiseMark[] {
  const out = new Map<string, PromiseMark>();
  for (const tag of tags) {
    if (tag[0] !== TAG_MARK) continue;
    const [, promiseId, state, note] = tag;
    if (
      typeof promiseId !== "string" ||
      !PROMISE_ID_RE.test(promiseId) ||
      !isMarkState(state) ||
      out.has(promiseId)
    )
      continue;
    out.set(promiseId, {
      promiseId,
      state,
      note:
        typeof note === "string"
          ? note.trim().slice(0, PROMISE_LIMITS.note)
          : "",
    });
    if (out.size >= PROMISE_LIMITS.answers) break;
  }
  return [...out.values()];
}

/** An update, as far as the record needs it. */
export interface RecordUpdate {
  id: string;
  author: string;
  createdAt: number;
  promises?: readonly UpdatePromise[];
  marks?: readonly PromiseMark[];
}

/**
 * How a promise stands. `waiting`: the next update has not been posted yet. `unanswered`: a later update was posted
 * and did not say.
 */
export type PromiseState =
  | "kept"
  | "missed"
  | "changed"
  | "waiting"
  | "unanswered";

const STATE_OF_MARK: Record<MarkState, PromiseState> = {
  done: "kept",
  "not-done": "missed",
  changed: "changed",
};

export interface PromiseEntry {
  id: string;
  text: string;
  promisedAt: number;
  state: PromiseState;
  /** When it was answered, or null. */
  answeredAt: number | null;
  note: string;
}

/**
 * Every promise the founder's updates made, with how each stands, newest first (by when it was answered, or made when
 * it has not been). `updates` are the project's team updates; anyone else's are ignored.
 */
export function promiseRecord(
  updates: readonly RecordUpdate[],
  founder: string,
): PromiseEntry[] {
  const mine = updates
    .filter((update) => update.author === founder)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const made = new Map<string, { at: number; updateId: string }>();
  for (const update of mine)
    for (const promise of update.promises ?? [])
      made.set(`${update.id}:${promise.index}`, {
        at: update.createdAt,
        updateId: update.id,
      });
  // Oldest update first, so the first answer to a promise is the one kept.
  const answers = new Map<string, { mark: PromiseMark; at: number }>();
  for (const update of mine)
    for (const mark of update.marks ?? []) {
      const promise = made.get(mark.promiseId);
      // An answer comes after its promise, in another update.
      if (
        !promise ||
        promise.updateId === update.id ||
        update.createdAt < promise.at ||
        answers.has(mark.promiseId)
      )
        continue;
      answers.set(mark.promiseId, { mark, at: update.createdAt });
    }
  const newest = mine[mine.length - 1];
  const entries: PromiseEntry[] = [];
  for (const update of mine)
    for (const promise of update.promises ?? []) {
      const id = `${update.id}:${promise.index}`;
      const answer = answers.get(id);
      entries.push({
        id,
        text: promise.text,
        promisedAt: update.createdAt,
        state: answer
          ? STATE_OF_MARK[answer.mark.state]
          : newest && newest.id !== update.id
            ? "unanswered"
            : "waiting",
        answeredAt: answer?.at ?? null,
        note: answer?.mark.note ?? "",
      });
    }
  return entries.sort(
    (a, b) =>
      (b.answeredAt ?? b.promisedAt) - (a.answeredAt ?? a.promisedAt) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** How many promises the next update is asked about at once. */
const DUE_SHOWN = 20;

/** The promises still to answer, for the update dialog: newest first, at most twenty. */
export function duePromises(entries: readonly PromiseEntry[]): PromiseEntry[] {
  return entries
    .filter(
      (entry) => entry.state === "waiting" || entry.state === "unanswered",
    )
    .sort((a, b) => b.promisedAt - a.promisedAt || (a.id < b.id ? -1 : 1))
    .slice(0, DUE_SHOWN);
}

export interface PromiseTotals {
  kept: number;
  missed: number;
  changed: number;
  unanswered: number;
}

export function promiseTotals(entries: readonly PromiseEntry[]): PromiseTotals {
  const count = (state: PromiseState) =>
    entries.filter((entry) => entry.state === state).length;
  return {
    kept: count("kept"),
    missed: count("missed"),
    changed: count("changed"),
    unanswered: count("unanswered"),
  };
}

/** "12 kept, 2 missed, 1 changed", with ", 1 not answered" when there are any. Null when nothing was answered or due. */
export function promiseTotalsLine(totals: PromiseTotals): string | null {
  if (totals.kept + totals.missed + totals.changed + totals.unanswered === 0)
    return null;
  const base = `${totals.kept} kept, ${totals.missed} missed, ${totals.changed} changed`;
  return totals.unanswered > 0
    ? `${base}, ${totals.unanswered} not answered`
    : base;
}

export const PROMISE_STATE_LABEL: Record<PromiseState, string> = {
  kept: "Kept",
  missed: "Missed",
  changed: "Changed",
  waiting: "Promised",
  unanswered: "Not answered",
};

/**
 * What may be said as fact about a project's record, given how much of its records was read.
 *
 * Records are read newest first. An answer is always newer than its promise, so every promise that was read shows how
 * it really stands. What a cut read cannot know is what lies before it: older promises, and goals set long ago. So the
 * totals are not stated, and "this project has set no goal" is not stated either.
 */
export function recordFacts(input: { complete: boolean }): {
  totals: boolean;
  noGoal: boolean;
} {
  return { totals: input.complete, noGoal: input.complete };
}
