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

/** A unix time (seconds) as the reader writes dates and times. */
export function whenText(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The restrictions the server puts on a person (`buzz-relay` ingest, auth and board moderation), each said in plain
 * words with what still works. The server's own wording is the contract: a change there must change these.
 */
const RESTRICTIONS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^blocked: you are banned\b/i, () => "You are banned from this community."],
  [
    /^restricted: you are timed out until (\d+)$/,
    (m) =>
      `You are timed out in this community until ${whenText(Number(m[1]))}. You can still read; you can post again then.`,
  ],
  [
    /^restricted: you are muted on this board until (\d+)$/,
    (m) =>
      `You are muted on this board until ${whenText(Number(m[1]))}. You can still read it, and post everywhere else.`,
  ],
  [
    /^restricted: this thread is locked$/,
    () =>
      "This thread is locked. Only the board's moderators, owners and admins can reply.",
  ],
];

/** A restriction on the reader in plain words, or null when `message` is not one. */
export function restrictionText(message: string): string | null {
  const trimmed = message.trim();
  for (const [pattern, words] of RESTRICTIONS) {
    const match = pattern.exec(trimmed);
    if (match) return words(match);
  }
  return null;
}

/**
 * What to show when the server refuses a write: a restriction on the reader (a ban, a timeout, a board mute, a locked
 * thread) and a rate limit are said in plain words; any other reason is passed on as the server gave it, and no reason
 * at all becomes `failure`.
 */
export function refusalText(
  message: string | undefined,
  failure: string,
): string {
  if (!message) return failure;
  const restricted = restrictionText(message);
  if (restricted !== null) return restricted;
  const limited = /^rate-limited:\s*(.+)$/s.exec(message.trim());
  return limited ? asSentence(limited[1]) : message;
}

/**
 * Why live updates stopped for good (the server refused this reader), in plain words. A room or board the reader could
 * open but now may not read means they were removed from it (`restricted: channel access revoked`, then `restricted:
 * not a channel member` on the retry).
 */
export function liveRefusalText(reason: string | null): string {
  if (reason && /channel access revoked|not a channel member/i.test(reason))
    return "You no longer have access to this room or board. Live updates stopped.";
  const restricted = reason ? restrictionText(reason) : null;
  return (
    restricted ??
    "Live updates stopped: the server refused this account. Reload the page to try again."
  );
}
