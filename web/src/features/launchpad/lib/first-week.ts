/**
 * What a founder is told in a project's first week, in the words the page shows: when the first update is due, and
 * what a post's line says about a run of weeks. Plain counts of days from the project's own start; no clock beyond the
 * `now` the caller gives.
 *
 * Pure and alias-free: `first-week.test.mjs` drives it under `node --test`.
 */

const DAY = 86_400;
/** A project's first update is due a week after it started. */
export const FIRST_UPDATE_DAYS = 7;

/**
 * "Your first update is due in 7 days." for a project started today, counting down to "due in 1 day", and "Your first
 * update is due now." from the seventh day on. `startedAt` and `now` are in seconds.
 */
export function firstUpdateWords(startedAt: number, now: number): string {
  const gone = Math.max(0, Math.floor((now - startedAt) / DAY));
  const left = FIRST_UPDATE_DAYS - gone;
  if (left <= 0) return "Your first update is due now.";
  return `Your first update is due in ${left} ${left === 1 ? "day" : "days"}.`;
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
