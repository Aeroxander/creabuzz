/**
 * A failure as words a person can read in main copy. A server refusal with plain words (a restriction on the reader,
 * an invite-only server, the request limit) is said in them; a sentence the app wrote is kept; anything else (a
 * timeout, a dropped socket, the server's internal failure) is said plainly, its raw words kept for Technical details.
 *
 * Alias-free: `readable-error.test.mjs` drives it under `node --test`.
 */
import { relayFailureOutcome, relayMessageOf } from "./relay-failure.ts";
import {
  asSentence,
  plainRefusalText,
  SERVER_FAILED_TEXT,
} from "./refusal-text.ts";

/** Message text for an unknown thrown value, untouched (callers that match on the server's words read this). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown error");
}

/** The server's refusal in plain words, or null when the failure is not one that has them. */
export function plainErrorText(error: unknown): string | null {
  const relayMessage = relayMessageOf(error);
  return relayMessage === null ? null : plainRefusalText(relayMessage);
}

/**
 * A failed read as one sentence for main copy, put after "Couldn't load …" and before a Try again button: plain words
 * for a known refusal or a sentence the app wrote, else what kind of failure it was, never the socket's or the
 * server's own code. {@link readFailureWords} keeps the raw words too.
 */
export function readableError(error: unknown): string {
  return readFailureWords(error).text;
}

/** What a failed read is said as when it has no plain words: by whether the server answered at all. */
export const READ_UNANSWERED_TEXT = "The server didn't answer.";
export const READ_REFUSED_TEXT = "The server couldn't do that just now.";
export const READ_SIGN_IN_TEXT =
  "The server needs you signed in. Unlock your passkey or sign in, then try again.";

/** {@link readableError} with the raw words kept for a Technical details. */
export function readFailureWords(error: unknown): FailureWords {
  const outcome = relayFailureOutcome(error);
  return failureWords(
    error,
    outcome === "unanswered"
      ? READ_UNANSWERED_TEXT
      : outcome === "auth-required"
        ? READ_SIGN_IN_TEXT
        : READ_REFUSED_TEXT,
  );
}

/** A failed action as people read it, and the raw words behind it for a collapsed Technical details. */
export interface FailureWords {
  /** What happened and what to do next. */
  text: string;
  /** The server's or browser's own words; null when `text` says it all. */
  detail: string | null;
}

/**
 * A failed write or action for main copy, with the raw words kept for Technical details:
 *
 * - a restriction on the reader or the request limit: its plain words (`refusal-text.ts`);
 * - a server refusal with words for people (`restricted: only an admin can add people`): those words, without the prefix;
 * - a sentence the app wrote itself (`The server did not accept this write. Try again.`): as it is;
 * - anything else — the server's internal failures (`error: database error: down`), a timeout, `HTTP 500`, a bare code:
 *   `fallback`, which says what did not happen and what to do.
 */
export function failureWords(
  error: unknown,
  fallback: string = SERVER_FAILED_TEXT,
): FailureWords {
  const raw = errorMessage(error).trim();
  const said = (text: string): FailureWords => ({
    text,
    detail: raw === "" || raw === text ? null : raw,
  });
  const plain = plainErrorText(error) ?? (raw ? plainRefusalText(raw) : null);
  if (plain !== null) return said(plain);
  const relayMessage = relayMessageOf(error);
  const refused = PEOPLE_WORDS_REFUSAL.exec(relayMessage ?? raw);
  if (refused) return said(asSentence(refused[1]));
  if (
    relayMessage === null &&
    APP_SENTENCE.test(raw) &&
    !TRANSPORT_WORDS.test(raw)
  )
    return said(raw);
  return said(fallback);
}

/** The server's refusal prefixes whose words are written for people; `error:` and the rest are for whoever runs it. */
const PEOPLE_WORDS_REFUSAL =
  /^(?:restricted|invalid|blocked|duplicate|rate-limited):\s*(\S.*)$/s;

/**
 * A sentence as the app writes them for people: a capital first letter and a full stop, and no `Word:` code in front
 * (`Error: database error: down.` is not one; a time such as `2:39 PM` inside one is fine).
 */
const APP_SENTENCE = /^(?![A-Za-z-]+:\s)[A-Z].*[.!?]$/s;

/**
 * What browsers and this app's own socket code say when nothing answered: capitalised and sometimes with a full stop,
 * but not words for people (`WebSocket connection failed.`, Firefox's `NetworkError when attempting to fetch
 * resource.`, Chrome's `Failed to fetch`, Safari's `Load failed`, `Server query timed out after 15000ms`, `Server query
 * ended without an answer.`, `Server closed the connection before finishing the query.`).
 */
const TRANSPORT_WORDS =
  /^(?:WebSocket\b|NetworkError\b|Failed to fetch\b|Load failed\b|Server (?:query|publish)\b|Server closed the connection\b)|\b\d+\s?ms\b/i;
