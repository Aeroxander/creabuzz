/**
 * What a helper types into the hand-in box beyond the words, links and files: how they checked the work, whether
 * every step was needed (a labelled agent helper's own line), and numbers they report.
 *
 * The checks and the step line are written into the hand-in's words, under plain labels, so they are public text like
 * the rest and no new tag is needed. The numbers become `task-result` tags (`task-results.ts`). Nothing typed here
 * is checked by anyone else, and the page says so wherever it is shown.
 *
 * Pure and alias-free: `hand-in-draft.test.mjs` drives it under `node --test`.
 */

import {
  type ReportedResult,
  RESULT_LIMITS,
  readResultTag,
  resultTag,
} from "./task-results.ts";
import { TASK_LIMITS } from "./tasks.ts";

/** The labels the extra lines carry in a hand-in's words. */
export const CHECKED_LABEL = "How I checked it:";
export const NOT_MET_LABEL = "Not met yet:";
export const STEPS_LABEL = "Was every step needed?";

export interface HandInWords {
  did: string;
  checked: string;
  notMet: string;
  /** An agent helper's own line. Empty for a person. */
  stepsNeeded: string;
}

/** The hand-in's words: what was done, then each extra line that has something in it, under its label. */
export function handInNote(input: HandInWords): string {
  const lines = [
    [CHECKED_LABEL, input.checked],
    [NOT_MET_LABEL, input.notMet],
    [STEPS_LABEL, input.stepsNeeded],
  ]
    .map(([label, text]) => [label, text.trim()])
    .filter(([, text]) => text !== "")
    .map(([label, text]) => `${label} ${text}`);
  return [input.did.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Why the words cannot be sent, in plain words, or null. They are one record: it holds at most so many characters. */
export function handInWordsProblem(input: HandInWords): string | null {
  const note = handInNote(input);
  return note.length > TASK_LIMITS.note
    ? `These words together are ${note.length - TASK_LIMITS.note} characters over the ${TASK_LIMITS.note} a hand-in holds. Shorten what you did or how you checked it.`
    : null;
}

/** One row of the numbers table, as typed. */
export interface ResultDraft {
  name: string;
  value: string;
  unit: string;
  baseline: string;
  sampleSize: string;
  producedBy: string;
}

export const EMPTY_RESULT: ResultDraft = {
  name: "",
  value: "",
  unit: "",
  baseline: "",
  sampleSize: "",
  producedBy: "",
};

const blank = (row: ResultDraft) =>
  Object.values(row).every((field) => field.trim() === "");

/**
 * The numbers typed, read for sending: a row with nothing in it is left out, every other row must pass the bounds the
 * server holds a hand-in to. Either the results, or the first reason in plain words.
 */
export function readResultDrafts(
  rows: readonly ResultDraft[],
): { results: ReportedResult[] } | { problem: string } {
  const results: ReportedResult[] = [];
  const names = new Set<string>();
  for (const row of rows) {
    if (blank(row)) continue;
    if (results.length >= RESULT_LIMITS.results)
      return {
        problem: `Add at most ${RESULT_LIMITS.results} numbers to one hand-in.`,
      };
    const trimmed: ResultDraft = {
      name: row.name.trim(),
      value: row.value.trim(),
      unit: row.unit.trim(),
      baseline: row.baseline.trim(),
      sampleSize: row.sampleSize.trim(),
      producedBy: row.producedBy.trim(),
    };
    if (trimmed.name === "")
      return { problem: "Give each number a name, like pass rate." };
    const read = readResultTag(resultTag(trimmed));
    if ("problem" in read) return read;
    const key = read.result.name.toLowerCase();
    if (names.has(key))
      return { problem: `"${read.result.name}" is given twice.` };
    names.add(key);
    results.push(read.result);
  }
  return { results };
}
