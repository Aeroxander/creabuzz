/**
 * A failure as words a person can read in main copy. A server refusal with plain words (a restriction on the reader,
 * an invite-only server, the request limit) is said in them; anything else is passed on as it was thrown.
 *
 * Alias-free: `readable-error.test.mjs` drives it under `node --test`.
 */
import { relayMessageOf } from "./relay-failure.ts";
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

/** The failure as one sentence for main copy: plain words for a known refusal, else the thrown message. */
export function readableError(error: unknown): string {
  const plain = plainErrorText(error);
  if (plain !== null) return plain;
  const message = errorMessage(error).trim();
  return message === "" ? "" : asSentence(message);
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
  if (relayMessage === null && APP_SENTENCE.test(raw)) return said(raw);
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
