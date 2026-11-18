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

/** What a server failure with no words for people (`error: database error: down`) is said as. */
export const SERVER_FAILED_TEXT =
  "The server couldn't do that just now. Try again.";

/** What someone not on an invite-only server's list is told, wherever the server refuses them. */
export const INVITE_ONLY_TEXT =
  "This server is invite-only. Open the invite link you were sent.";

/** What someone removed from a private room or board is told when the server closes their live view of it. */
export const ACCESS_REMOVED_TEXT =
  "You no longer have access to this room or board.";

/**
 * What a reader who is not on a private room or board's list is told: they may have been removed, or never been added
 * (the server says `not a channel member` in both cases), so the words do not claim either.
 */
export const NO_ACCESS_TEXT =
  "You don't have access to this room or board. Its owner can add you.";

/**
 * A ban as the server states it in its refusal (`handlers/auth.rs` `ban_refusal`): `blocked: you are banned from this
 * community`, then ` until <unix seconds>` or ` for good`, then `; reason: <the moderator's words>` when they gave one.
 * An older server, or a refusal that does not say, gives only the first part.
 */
export type BanNotice = {
  /** When it ends (unix seconds), `"never"` for a ban for good, or null when the server did not say. */
  ends: number | "never" | null;
  /** The moderator's reason, or null when there is none. */
  reason: string | null;
};

/** The ban in a server refusal, or null when `message` is not a ban. */
export function parseBan(message: string): BanNotice | null {
  const match =
    /^blocked: you are banned\b(?: from this community)?(?: until (\d+)| (for good))?(?:; reason: (.*))?$/is.exec(
      message.trim(),
    );
  if (!match) return null;
  const reason = match[3]?.trim();
  return {
    ends: match[1] ? Number(match[1]) : match[2] ? "never" : null,
    reason: reason ? reason : null,
  };
}

/** The ban in a failure's message wherever it is said in it (after a client's own words), or null when there is none. */
export function banIn(message: string): BanNotice | null {
  const at = message.search(/blocked: you are banned\b/i);
  return at < 0 ? null : parseBan(message.slice(at));
}

/** "You are banned from this community", then until when or "for good" when the server said, with no full stop. */
export function banHeadline(ends: BanNotice["ends"]): string {
  if (ends === "never") return "You are banned from this community for good";
  if (ends === null) return "You are banned from this community";
  return `You are banned from this community until ${whenText(ends)}`;
}

/** A ban in plain words: until when (when the server said), then the moderator's reason (when they gave one). */
export function banText(ban: BanNotice): string {
  const head = `${banHeadline(ban.ends)}.`;
  return ban.reason ? `${head} Reason: ${asSentence(ban.reason)}` : head;
}

/**
 * The restrictions the server puts on a person (`buzz-relay` ingest, auth and board moderation), each said in plain
 * words with what still works. The server's own wording is the contract: a change there must change these.
 */
const RESTRICTIONS: [RegExp, (match: RegExpExecArray) => string][] = [
  [
    /^blocked: you are banned\b.*$/is,
    (m) => banText(parseBan(m[0]) ?? { ends: null, reason: null }),
  ],
  [
    /^restricted: you are timed out until (\d+)$/,
    (m) =>
      `You are muted everywhere in this community until ${whenText(Number(m[1]))}. You can still read; you can post again then.`,
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
  // An invite-only server refuses someone not on its list: on the socket (`handlers/auth.rs`) and over HTTP
  // (`api/mod.rs`, whose JSON `error` code is what the app passes on).
  [
    /^(restricted: not a relay member|relay_membership_required)$/,
    () => INVITE_ONLY_TEXT,
  ],
  // A private room or board the reader is not on: the live subscription of someone removed is closed with `channel
  // access revoked` (`handlers/side_effects.rs`); every read or write by anyone not on its list, removed or never
  // added, is refused with `not a channel member` (`handlers/req.rs`, `handlers/ingest.rs`).
  [/^restricted: channel access revoked$/, () => ACCESS_REMOVED_TEXT],
  [/^restricted: not a channel member$/, () => NO_ACCESS_TEXT],
  // Who may sign a project's records (`handlers/launch_update_authority.rs`): checked against the project's own
  // record when the record is written.
  [
    /^restricted: only this project's founder can post this$/,
    () =>
      "Only this project's founder can post goals and promises. Ask the founder to post it.",
  ],
  [
    /^restricted: only this project's team can post this$/,
    () =>
      "Only this project's team can post this. If you should be on the team, ask the founder to add you to the project, then try again.",
  ],
  [
    /^restricted: a task's work must be confirmed by someone other than its helper$/,
    () =>
      "The person who did the work can't confirm it, and neither can whoever runs them. Ask someone else on the project's team to check it.",
  ],
  [
    /^restricted: only the helper this task names can post this$/,
    () =>
      "Only the person this task names can do this. If the task should be yours, ask the project's team to make one for you.",
  ],
  [
    /^invalid: this record names a project that is not on this server$/,
    () =>
      "This project is not on this server, so nothing can be posted to it. Check you are in the right community, then try again.",
  ],
  [
    /^invalid: this step names a task that is not on this server$/,
    () =>
      "This task is no longer on this server (it may have been removed), so the step was not saved. Reload the page to see what is there now.",
  ],
  [
    /^invalid: this step names a task from another project$/,
    () =>
      "This task belongs to another project, so the step was not saved. Open the task from its own project's page.",
  ],
  // Removals (`handlers/ingest.rs`, `handlers/side_effects.rs`): one record at a time, and never a removal itself.
  [
    /^invalid: deletion events must reference exactly one target\b.*$/s,
    () =>
      "The server removes one record at a time, and this asked for several at once. Nothing was removed. Try again.",
  ],
  [
    /^(?:invalid: |error: )?a deletion cannot be deleted\b.*$/s,
    () =>
      "A removal can't be removed: once a record is removed, that stays on the record. Nothing was changed.",
  ],
];

/** The restriction a failed send was refused with, in plain words with what to do next, or null when it was not one. */
export function restrictionOf(error: unknown): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message ? restrictionText(message) : null;
}

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
 * A refusal said in plain words, or null when it has none and the server's own wording is all there is: a restriction
 * on the reader (a ban, a timeout, an invite-only server) or the general request limit.
 */
export function plainRefusalText(message: string): string | null {
  return restrictionText(message) ?? requestLimitText(message);
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
  const plain = plainRefusalText(message);
  if (plain !== null) return plain;
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
    return `${ACCESS_REMOVED_TEXT} Live updates stopped.`;
  const restricted = reason ? restrictionText(reason) : null;
  if (restricted !== null) return restricted;
  // Opening pages too fast is a short wait, not a refusal of the account.
  const limit = reason ? requestLimit(reason) : null;
  if (limit === "busy")
    return "Live updates stopped because the server is busy. Reload the page in a moment.";
  if (limit !== null)
    return `Live updates stopped because you're doing that a bit fast. Reload the page in ${waitText(limit)}.`;
  return "Live updates stopped: the server refused this account. Reload the page to try again.";
}

/**
 * The server's general request limit in plain words, or null when `message` is not it. Every read and write a signed-in
 * person sends counts toward one limit per few seconds (`buzz-relay` `rejection.rs`, `send_admission_result`), and when
 * the server cannot check that limit it refuses rather than guess. Its wording is the contract, as above.
 */
export function requestLimitText(message: string): string | null {
  const limit = requestLimit(message);
  if (limit === null) return null;
  if (limit === "busy") return "The server is busy. Try again in a moment.";
  return `You're doing that a bit fast. Try again in ${waitText(limit)}.`;
}

/** The general request limit's refusal: the seconds to wait, `"busy"` when the server could not check it, or null. */
function requestLimit(message: string): number | "busy" | null {
  const trimmed = message.trim();
  const exceeded = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
    trimmed,
  );
  if (exceeded) return Number(exceeded[1]);
  if (trimmed === "rate-limited: shared admission unavailable") return "busy";
  return null;
}

/** "N seconds", "1 second", or "a moment" when the window rolled over as the refusal was sent (no "0 seconds"). */
function waitText(seconds: number): string {
  if (seconds <= 0) return "a moment";
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
