/**
 * Four honest outcomes for a relay query — and only four.
 *
 * A query can end as *ok* (the relay answered: EOSE, possibly zero events),
 * *answered-and-refused* (CLOSED/notice/HTTP error with the relay's own
 * wording), *auth-required* (the relay only answers authenticated reads, or
 * this browser cannot sign the challenge because its passkey is locked), or
 * *unanswered* (timeout, dropped socket, refused connection).
 *
 * The fourth one is the product blocker: a private relay answers `missing
 * Nostr auth` — and a locked passkey cannot sign NIP-42 AUTH at all — yet
 * every surface used to render that as "the relay did not answer", sending
 * the reader to debug their network when the fix is a sign-in tap. Every
 * failure path through `queryEvents` is funnelled through
 * `finalizeRelayQuery`, so the copy a page renders derives from this table
 * instead of from whatever the socket happened to do last.
 *
 * Pure module: no DOM, no socket — the classification is testable on its own
 * and `nostr-client` only supplies the raw material.
 */

import { isSigningBlockedError } from "./nostr-signer.ts";

/** Success: the relay answered with events (possibly zero). */
export interface RelayOkOutcome<T> {
  state: "ok";
  events: T[];
}

/**
 * The relay answered *and refused*. `message` is the relay's own wording,
 * verbatim — never re-written, never downgraded to "no answer".
 */
export interface RelayAnsweredOutcome {
  state: "answered";
  message: string;
}

/**
 * No authenticated identity reached the relay: it demands sign-in, or this
 * browser could not sign the challenge. `message` is the relay's wording when
 * it stated one, otherwise the local reason.
 */
export interface RelayAuthRequiredOutcome {
  state: "auth-required";
  message: string | null;
}

/** Nobody answered: timeout, refused connection, socket closed mid-query. */
export interface RelayUnansweredOutcome {
  state: "unanswered";
}

export type RelayQueryOutcome<T> =
  | RelayOkOutcome<T>
  | RelayAnsweredOutcome
  | RelayAuthRequiredOutcome
  | RelayUnansweredOutcome;

/** Which of the three *failures* an error is (success is not a failure). */
export type RelayFailureKind = "auth-required" | "answered" | "unanswered";

/**
 * A query failure that carries the relay's verbatim reply.
 *
 * Thrown for every terminal refusal the relay actually stated: `CLOSED` with
 * a reason, an `OK … false` on the auth event, an HTTP error body, an error
 * `NOTICE`.
 */
export class RelayAnsweredError extends Error {
  /** The relay's wording, untouched. */
  readonly relayMessage: string;

  constructor(message: string) {
    super(message);
    this.name = "RelayAnsweredError";
    this.relayMessage = message;
  }
}

/** Wrap a verbatim relay refusal so downstream copy can tell it apart. */
export function relayAnswered(message: string): RelayAnsweredError {
  return new RelayAnsweredError(message);
}

/**
 * The relay's verbatim wording out of a failure, or null when the failure
 * says nothing about what the relay replied (timeout, socket error, local
 * signing block).
 */
export function relayMessageOf(error: unknown): string | null {
  if (error instanceof RelayAnsweredError) return error.relayMessage;
  if (error instanceof Error) {
    const withMessage = error as Error & { relayMessage?: unknown };
    if (typeof withMessage.relayMessage === "string") {
      return withMessage.relayMessage;
    }
  }
  return null;
}

/**
 * Words a relay uses when it will only answer authenticated reads.
 *
 * Covers the shapes this client actually observes: the HTTP bridge body
 * (`missing Nostr auth`), the WS `auth-required:` CLOSED/NOTICE wording, and
 * generic "authenticate before subscribing" phrasings. Deliberately narrow —
 * a `restricted: … #p …` refusal means signing in will NOT help and must stay
 * a plain answered refusal.
 */
export function isAuthRequiredMessage(message: string): boolean {
  return /missing nostr auth|auth-required|authenticate before subscribing|not authenticated|authentication required|auth required/i.test(
    message,
  );
}

/**
 * NOTICE texts that state a refusal. Buzz's refusal vocabulary is
 * colon-prefixed (`restricted:`, `auth-required:`, `error:`) — matched on the
 * leading word so an informational notice ("rate limited, retry in 4s") never
 * gets promoted into a terminal answer.
 */
export function isErrorNotice(text: string): boolean {
  return /^(error|restricted|invalid|unauthorized|forbidden|bad request|not accepted|auth-required)\b/i.test(
    text.trim(),
  );
}

/** The reader-facing reason, or null when the error states none. */
function reasonText(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return null;
}

/**
 * Which failure an error is. Binding rule: a locked passkey or an auth
 * refusal is `auth-required` even when the transport also failed — the reader
 * has an action for it (sign in), and hiding that behind "did not answer" is
 * what locked this product's users out.
 */
export function relayFailureOutcome(error: unknown): RelayFailureKind {
  if (isSigningBlockedError(error)) return "auth-required";
  const relayMessage = relayMessageOf(error);
  if (relayMessage !== null) {
    return isAuthRequiredMessage(relayMessage) ? "auth-required" : "answered";
  }
  return "unanswered";
}

function answeredOrAuth(
  message: string,
): RelayAnsweredOutcome | RelayAuthRequiredOutcome {
  return isAuthRequiredMessage(message)
    ? { state: "auth-required", message }
    : { state: "answered", message };
}

/**
 * Reduce what a query observed to one outcome.
 *
 * Order matters: a stated refusal wins over an empty list (never render
 * "nothing here" for a relay that said "no"), a stated refusal wins over an
 * unanswered transport failure (the relay *did* speak — its words are the
 * diagnosis), and an auth refusal wins over both (it has an action the other
 * two don't).
 */
export function finalizeRelayQuery<T>(input: {
  events: T[];
  notices?: readonly string[];
  failure?: unknown;
}): RelayQueryOutcome<T> {
  const statedNotice =
    (input.notices ?? []).find((notice) => isErrorNotice(notice)) ?? null;

  if (input.failure !== undefined && input.failure !== null) {
    if (isSigningBlockedError(input.failure)) {
      return { state: "auth-required", message: reasonText(input.failure) };
    }
    const relayMessage = relayMessageOf(input.failure);
    if (relayMessage !== null) return answeredOrAuth(relayMessage);
    if (statedNotice !== null) return answeredOrAuth(statedNotice);
    return { state: "unanswered" };
  }

  if (input.events.length === 0 && statedNotice !== null) {
    return answeredOrAuth(statedNotice);
  }
  return { state: "ok", events: input.events };
}

/** `37015`, `37015, 37016` — never "(kind )". */
function formatKinds(kinds: readonly number[]): string {
  return kinds.join(", ");
}

/** Kind numbers the relay itself named, e.g. `restricted: unknown kind 37015`. */
function kindsNamedIn(message: string): string | null {
  const matches = [...message.matchAll(/\bkind[:\s]+(\d{3,6})\b/gi)].map(
    (match) => match[1],
  );
  return matches.length > 0 ? matches.join(", ") : null;
}

/**
 * Plain-language guidance for an answered refusal.
 *
 * "Unknown event kind" is almost always a relay older than this build (the
 * relay does not validate kinds on the read path, so the string arrives from
 * an ingest/rejection), and the fix is the relay's, not the reader's — say
 * which kind and what to do. Anything else gets the honest generic line: the
 * relay answered, its words are above, and an empty page would be a lie about
 * what is stored here.
 */
export function relayFailureGuidance(
  message: string,
  kinds?: readonly number[],
): string {
  if (/unknown event kind/i.test(message)) {
    const named =
      kinds && kinds.length > 0 ? formatKinds(kinds) : kindsNamedIn(message);
    const scope = named ? ` (kind ${named})` : "";
    return `This relay is running an older build that doesn't know these records${scope} — restart it from the current build, or point the app at a newer relay.`;
  }
  return "The relay answered and refused this request — its own message is shown above, word for word. Nothing is listed because an empty page would claim there is nothing here.";
}
