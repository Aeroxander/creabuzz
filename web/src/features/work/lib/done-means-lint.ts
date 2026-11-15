/**
 * A plain lint of what "Done means" says when a task is made. It warns and never blocks: the team decides what its
 * own words are. Two things are looked for.
 *
 * - **Nothing to check against.** No number, no link and no named deliverable (a report, a recording, a pull request, a
 *   file such as `chart.png`): a reviewer has nothing to count or open.
 * - **Vague words.** "Good", "better", "properly" and their kind mean something different to each reader. They are
 *   named so the team can swap them for what a reviewer would see.
 *
 * Pure and alias-free: `done-means-lint.test.mjs` drives it under `node --test`. This is a reading of the words, not a
 * judgement of the work; an AI helper (`helperAi.ts` in core) may propose sharper words, which the team accepts or edits.
 */

export type DoneMeansWarning =
  | { kind: "measure"; message: string }
  | { kind: "vague"; message: string; words: string[] };

/** Words that read differently to each person. A short list on purpose: only words that rarely say anything checkable. */
const VAGUE = [
  "good",
  "great",
  "nice",
  "better",
  "best",
  "improve",
  "improved",
  "improvement",
  "enough",
  "properly",
  "well",
  "polished",
  "clean",
  "fast",
  "quick",
  "quickly",
  "easy",
  "simple",
  "robust",
  "decent",
  "reasonable",
  "ok",
  "okay",
  "stuff",
  "things",
  "some",
  "etc",
  "as needed",
  "as appropriate",
  "and so on",
] as const;

/** The things a task can hand in. Naming one gives a reviewer something to open, even before a number is written. */
const DELIVERABLES = [
  "link",
  "url",
  "page",
  "site",
  "report",
  "chart",
  "recording",
  "video",
  "screenshot",
  "screen recording",
  "file",
  "document",
  "doc",
  "spreadsheet",
  "pull request",
  "pr",
  "commit",
  "patch",
  "branch",
  "release",
  "build",
  "demo",
  "dataset",
  "design",
  "mockup",
  "article",
  "post",
  "guide",
  "summary",
  "list",
  "script",
  "test",
  "tests",
  "email",
  "slides",
  "deck",
  "logo",
  "translation",
  "app",
] as const;

const FILE_NAME =
  /\b[\w-]+\.(?:pdf|md|png|jpe?g|gif|svg|mp4|mov|csv|json|zip|txt|docx?|xlsx?|html?|css|jsx?|tsx?|py|rs|go)\b/i;
const LINK = /\bhttps?:\/\/\S+/i;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyWord = (words: readonly string[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.map(escapeRegExp).join("|")})s?(?![\\p{L}\\p{N}])`,
    "giu",
  );
const DELIVERABLE = anyWord(DELIVERABLES);
const VAGUE_WORD = anyWord(VAGUE);

/** Whether the words give a reviewer something to count or open. */
function measurable(text: string): boolean {
  return (
    /\d/.test(text) ||
    LINK.test(text) ||
    FILE_NAME.test(text) ||
    /["“][^"”]{3,}["”]/.test(text) ||
    new RegExp(DELIVERABLE.source, "iu").test(text)
  );
}

/** The vague words used, each once, as written (lower case), in the order they first appear. */
function vagueWords(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(VAGUE_WORD)) {
    // "and so on" and "etc" are kept whole; a plural "s" is not part of the word the team wrote.
    const word = match[0].toLowerCase();
    const base = (VAGUE as readonly string[]).includes(word.replace(/s$/, ""))
      ? word.replace(/s$/, "")
      : word;
    if (!found.includes(base)) found.push(base);
  }
  return found;
}

/**
 * What to say about the words of "Done means", or nothing. Empty words get no warning here: leaving them empty is
 * already refused by `taskProblem`.
 */
export function lintDoneMeans(text: string): DoneMeansWarning[] {
  const words = text.trim();
  if (words === "") return [];
  const warnings: DoneMeansWarning[] = [];
  if (!measurable(words))
    warnings.push({
      kind: "measure",
      message:
        "A reviewer has nothing to count or open yet. Add a number, a link, or the name of what will exist.",
    });
  const vague = vagueWords(words);
  if (vague.length > 0)
    warnings.push({
      kind: "vague",
      words: vague,
      message: `${vague.map((word) => `"${word}"`).join(", ")} can mean different things to different people. Say what a reviewer would see or measure instead.`,
    });
  return warnings;
}
