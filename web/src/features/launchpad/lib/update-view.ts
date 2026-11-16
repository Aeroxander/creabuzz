/**
 * One weekly update, laid out for reading: what it said about last week's promises, what happened this week, and what
 * it promises for next week. It is read from what the update signed (its promise tags, its answers and its parts), so
 * a promise is never shown as kept because a line of words said so.
 *
 * A promise the update does not answer is "Not answered", never "Kept". That is known only when the update before it
 * was read (`previous`); with a cut read the rows are the answers the update gave and nothing is said about the rest.
 * An update without any of this (an older or free-form one) is shown as written.
 *
 * Pure and alias-free: `update-view.test.mjs` drives it under `node --test`.
 */

import type { MarkState, PromiseMark, UpdatePromise } from "./promises.ts";
import { promiseLines } from "./promises.ts";
import { type UpdateParts, updateLayout } from "./weekly-update.ts";

/** How a promise from last week stands in this update. */
export type LastWeekState = "kept" | "missed" | "changed" | "unanswered";

/** What each row says. "Not answered" is its own word, so a missing answer never reads as a good one. */
export const LAST_WEEK_LABEL: Record<LastWeekState, string> = {
  kept: "Kept",
  missed: "Missed",
  changed: "Changed",
  unanswered: "Not answered",
};

const STATE_OF_MARK: Record<MarkState, LastWeekState> = {
  done: "kept",
  "not-done": "missed",
  changed: "changed",
};

/** Said where an answer names a promise whose words are not known here. */
const EARLIER_PROMISE = "A promise from an earlier update";

/** The part of an update this needs. */
export interface ViewableUpdate {
  id: string;
  author: string;
  createdAt: number;
  body: string;
  parts?: UpdateParts | null;
  promises?: readonly UpdatePromise[];
  marks?: readonly PromiseMark[];
  weekly?: boolean;
}

interface LastWeekRow {
  state: LastWeekState;
  text: string;
  /** The reason the founder gave, or empty. */
  note: string;
}

export interface UpdateView {
  /** Whether the update could be laid out. False: show `plain` as it was written. */
  structured: boolean;
  /** The words as written, for an update that is not laid out. */
  plain: string;
  lastWeek: LastWeekRow[];
  thisWeek: string;
  /** The promises it makes (one per line of "What's next"), or the lines of "What's next" when it made none. */
  nextWeek: string[];
  /** Whether `nextWeek` are signed promises (the founder's) or plans (a teammate's, or from before promises). */
  nextAreSigned: boolean;
}

/** The id of a promise: its update and its number there. */
const promiseId = (updateId: string, index: number) => `${updateId}:${index}`;

/** The words of every promise a list of updates made, by promise id. */
export function promiseTexts(
  updates: readonly Pick<ViewableUpdate, "id" | "promises">[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const update of updates)
    for (const promise of update.promises ?? [])
      out.set(promiseId(update.id, promise.index), promise.text);
  return out;
}

/**
 * The founder's weekly update just before `update`: the one whose promises `update` answers. Null when there is none
 * or when `update` is not the founder's (a teammate's update answers nothing).
 */
export function previousWeekly<T extends ViewableUpdate>(
  updates: readonly T[],
  update: ViewableUpdate,
  founder: string,
): T | null {
  if (update.author !== founder) return null;
  let best: T | null = null;
  for (const other of updates) {
    if (other.author !== founder || other.id === update.id || !other.weekly)
      continue;
    if (other.createdAt > update.createdAt) continue;
    if (!best || other.createdAt > best.createdAt) best = other;
  }
  return best;
}

const MARK_LINE = /^(Done|Not done|Changed): (.*)$/;
const MARKS_HEADING = "What we said last time";

/**
 * Takes the answers' own section off the end of an update's free words (it sits just before the prompts' sections) and
 * returns what is left and the promise words it carried, in order. A section that does not look exactly as the dialog
 * wrote it is left in place.
 */
function takeMarksSection(
  free: string,
  marks: readonly PromiseMark[],
): { rest: string; texts: string[] } {
  if (marks.length === 0) return { rest: free, texts: [] };
  const start = free.lastIndexOf(MARKS_HEADING);
  if (start < 0 || (start > 0 && free.slice(start - 2, start) !== "\n\n"))
    return { rest: free, texts: [] };
  const lines = free
    .slice(start + MARKS_HEADING.length)
    .split("\n")
    .slice(1);
  if (lines.length === 0 || !lines.every((line) => MARK_LINE.test(line)))
    return { rest: free, texts: [] };
  const rest = free.slice(0, Math.max(0, start - 2)).trimEnd();
  if (lines.length !== marks.length) return { rest, texts: [] };
  return {
    rest,
    texts: lines.map((line, i) => {
      const words = (MARK_LINE.exec(line)?.[2] ?? "").trim();
      const note = marks[i].note;
      return note && words.endsWith(` (${note})`)
        ? words.slice(0, words.length - note.length - 3)
        : words;
    }),
  };
}

/** What is known beyond one update: the founder's update before it, the words of earlier promises, and the founder. */
export interface UpdateViewContext {
  /** The founder's update before it (see {@link previousWeekly}), given only when the read of updates was complete. */
  previous?: Pick<ViewableUpdate, "id" | "promises"> | null;
  /** The words of the promises known (see {@link promiseTexts}). */
  texts?: ReadonlyMap<string, string>;
  founder: string;
}

/** Lays an update out. */
export function updateView(
  update: ViewableUpdate,
  options: UpdateViewContext,
): UpdateView {
  const parts = update.parts ?? null;
  const promises = update.promises ?? [];
  const marks = update.marks ?? [];
  const layout = updateLayout(update.body, parts);
  const plainView: UpdateView = {
    structured: false,
    plain: update.body,
    lastWeek: [],
    thisWeek: "",
    nextWeek: [],
    nextAreSigned: false,
  };
  // Nothing to lay out, or the body was written by something else: shown as written.
  if (!parts && promises.length === 0 && marks.length === 0) return plainView;
  if (parts && !layout.showParts) return plainView;

  const { rest, texts: markTexts } = takeMarksSection(layout.free, marks);
  const thisWeek = [rest.trim(), parts?.done ?? ""]
    .filter((part) => part !== "")
    .join("\n\n");

  const answeredBy = new Map<string, PromiseMark>();
  for (const mark of marks) answeredBy.set(mark.promiseId, mark);
  const textOf = (id: string, fallback?: string) =>
    options.texts?.get(id) ?? fallback ?? EARLIER_PROMISE;

  const lastWeek: LastWeekRow[] = [];
  const seen = new Set<string>();
  const byFounder = update.author === options.founder;
  if (byFounder && options.previous) {
    for (const promise of options.previous.promises ?? []) {
      const id = promiseId(options.previous.id, promise.index);
      const mark = answeredBy.get(id);
      seen.add(id);
      lastWeek.push({
        state: mark ? STATE_OF_MARK[mark.state] : "unanswered",
        text: promise.text,
        note: mark?.note ?? "",
      });
    }
  }
  marks.forEach((mark, i) => {
    if (seen.has(mark.promiseId)) return;
    lastWeek.push({
      state: STATE_OF_MARK[mark.state],
      text: textOf(mark.promiseId, markTexts[i]),
      note: mark.note,
    });
  });

  const signed = promises.length > 0;
  const nextWeek = signed
    ? promises.map((promise) => promise.text)
    : promiseLines(parts?.next ?? "");

  return {
    structured: true,
    plain: "",
    lastWeek,
    thisWeek,
    nextWeek,
    nextAreSigned: signed,
  };
}
