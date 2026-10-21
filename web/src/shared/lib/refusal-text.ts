/**
 * The server's reasons for refusing a write, readable by people. A server reason looks like `reason: words`
 * (`rate-limited: you can start 5 boards a day; try again tomorrow`).
 *
 * Alias-free: `refusal-text.test.mjs` drives it under `node --test`.
 */

/** Words as a sentence: a capital first letter and a full stop. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  const sentence = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * What to show when the server refuses a write: a rate limit is already written for people, so it loses its prefix;
 * any other reason is passed on as the server gave it, and no reason at all becomes `failure`.
 */
export function refusalText(
  message: string | undefined,
  failure: string,
): string {
  if (!message) return failure;
  const limited = /^rate-limited:\s*(.+)$/s.exec(message.trim());
  return limited ? asSentence(limited[1]) : message;
}
