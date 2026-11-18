/**
 * What to say when the server's AI service refuses a question with a 429 (`api/llm_gateway.rs`): the account's daily
 * allowance, the whole server's daily total, the spending limit or the pace of asking. The server writes the sentence
 * in plain words (what ran out, when it comes back, that the person can write it themselves), so it is shown as it is.
 * Only when the body carries no such sentence does the app use its own.
 *
 * Pure and alias-free: `ai-refusal.test.mjs` drives it under `node --test`.
 */

/** Said when a 429 carries no sentence of its own. */
export const AI_BUSY_WORDS =
  "The AI service is busy or your allowance is used up. Try again later, or write it yourself.";

/** A refusal's sentence is a line or two: anything longer is not the server's plain words. */
const WORDS_MAX = 400;

/**
 * The server's own sentence from a refusal's JSON body (`{ error, code, retry_after_secs }`), or the app's fallback
 * when the body is missing, is not that shape, or its `error` is empty, too long or not a sentence.
 */
export function aiRefusalWords(body: unknown): string {
  if (body === null || typeof body !== "object") return AI_BUSY_WORDS;
  const { error } = body as { error?: unknown };
  if (typeof error !== "string") return AI_BUSY_WORDS;
  // Control characters (a stray newline, a terminal escape) are not words.
  const words = [...error]
    .map((char) => (char < " " || char === "\u007f" ? " " : char))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return words.length > 0 && words.length <= WORDS_MAX ? words : AI_BUSY_WORDS;
}
