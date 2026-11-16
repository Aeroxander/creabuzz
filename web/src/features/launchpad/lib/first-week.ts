/**
 * What a founder is told in a project's first week, in the words the page shows: the three steps and which are done,
 * the line after the first update, and what a post's line says about a run of weeks. No clock beyond the `now` the
 * caller gives.
 *
 * Pure and alias-free: `first-week.test.mjs` drives it under `node --test`.
 */

import { updateDueWords } from "./weekly-update.ts";

/** The card's heading and the one line under it: said once, to one person. */
export const FIRST_WEEK_HEADING = "Your first week";
export const FIRST_WEEK_LINE =
  "Three steps. You can do all of them on your own.";

/** The three steps, in order. None of them needs a second person, a key, an address or a hash. */
export type FirstWeekStepId = "goal" | "work" | "post";

export const FIRST_WEEK_STEPS: readonly {
  id: FirstWeekStepId;
  title: string;
  /** Who has to be there: nobody but the founder, for every step. A test holds it to the real rules. */
  needs: "founder";
}[] = [
  { id: "goal", title: "Say your goal", needs: "founder" },
  { id: "work", title: "Get one thing done", needs: "founder" },
  { id: "post", title: "Post week one", needs: "founder" },
];

/** What the card knows. `null` is "not read": it never counts as done, and never as none. */
export interface FirstWeekInput {
  /** Pieces of work finished on the project (checked by anyone), or null when the tasks were not read. */
  worksDone: number | null;
  /** Updates posted, or null when they were not read to their end. */
  updates: number | null;
}

export interface FirstWeekProgress {
  done: Record<FirstWeekStepId, boolean>;
  /** How many of the three are ticked. The goal is ticked from the start: a project is made with one. */
  count: number;
}

/** Which steps are ticked. */
export function firstWeekProgress(input: FirstWeekInput): FirstWeekProgress {
  const done = {
    goal: true,
    work: input.worksDone !== null && input.worksDone > 0,
    post: input.updates !== null && input.updates > 0,
  };
  return { done, count: Object.values(done).filter(Boolean).length };
}

/** "1 of 3". */
export const progressWords = (count: number) => `${count} of 3`;

/** The first-update words on the card's buttons. The post button is green only once the first thing is done. */
export const FIRST_WEEK_WORDS = {
  addWork: "Add what you did",
  addNext: "Or add something to do next",
  didIt: "I did it",
  post: "Post this week's update",
  workDone: "First piece of work done.",
  partSaved: "Saved part of this. Try again.",
  tryAgain: "Try again",
  bringSomeone: "Bring someone along",
  copyLink: "Copy the link",
  askForHelp: "Ask for help",
} as const;

/** "You said you would: <task>." */
export const youSaidWords = (what: string) =>
  `You said you would: ${what.trim().replace(/[.!?]+$/, "")}.`;

/**
 * What the card is: the three steps (no update yet), the one line after the first update (until the next one is due),
 * or gone (the project's update card takes over). A read that was not finished never shows the steps: the card does
 * not tell a founder with updates that they have none.
 */
export function firstWeekForm(input: {
  updates: number | null;
  lastUpdateAt: number | null;
  now: number;
}): "steps" | "done" | "gone" {
  if (input.updates === null) return "gone";
  if (input.updates === 0) return "steps";
  if (input.updates === 1 && input.lastUpdateAt !== null) {
    const due = updateDueWords(input.lastUpdateAt, input.now);
    if (due && !due.late) return "done";
  }
  return "gone";
}

/** "First week done. Next update: Mon, Nov 23." Null when the next update is not coming up (late, or never posted). */
export function firstWeekDoneLine(
  lastUpdateAt: number,
  now: number,
  locale?: string,
): string | null {
  const due = updateDueWords(lastUpdateAt, now, locale);
  if (!due || due.late) return null;
  return `First week done. ${due.text.replace(/^Next update /, "Next update: ")}.`;
}

/**
 * The line in the note after an update is posted, from what the project's own records show: weeks in a row (this
 * update included) and promises answered. A run of weeks is stated only once at least two promises are answered, the
 * same rule the share picture uses, so the sentence and the picture never disagree. `null` facts: the record has not
 * been read to its end, so nothing is claimed beyond the post.
 */
export function postedLine(
  facts: { streak: number; answered: number } | null,
): string {
  if (facts === null)
    return "It's on your project's record for everyone to read.";
  if (facts.streak >= 2 && facts.answered >= 2)
    return `That's ${facts.streak} weeks in a row. Keep it going next week.`;
  if (facts.streak >= 2)
    return "It's on your project's record. Post again next week to keep it going.";
  return "That's week one. Post again next week and your run begins.";
}
