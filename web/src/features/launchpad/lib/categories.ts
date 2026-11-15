/**
 * The kinds of project Start offers on its optional "What kind of project?" row.
 *
 * A fixed set, so every project lists under a name people recognise. The choice is written as the project's category
 * (its topic tag, the one Discover browses). It is optional: a project with no category, which is every project made
 * before this row existed, lists and opens exactly as before.
 *
 * Pure and alias-free: `categories.test.mjs` drives it under `node --test`.
 */

/** The categories Start offers, in the order the chips show. */
export const START_CATEGORIES = [
  "Software",
  "AI agent or tool",
  "Creative",
  "Community",
  "Other",
] as const;

type StartCategory = (typeof START_CATEGORIES)[number];

/**
 * A stored or typed value as one of the fixed categories, or "" for none. Anything outside the set (an old draft, a
 * hand-edited storage entry) is none, so the record never carries a category the picker could not have offered.
 */
export function startCategory(value: unknown): StartCategory | "" {
  if (typeof value !== "string") return "";
  const wanted = value.trim().toLowerCase();
  return START_CATEGORIES.find((name) => name.toLowerCase() === wanted) ?? "";
}
