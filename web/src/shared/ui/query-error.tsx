import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import {
  relayFailureGuidance,
  relayFailureOutcome,
  relayMessageOf,
} from "@/shared/lib/relay-failure";
import { plainRefusalText } from "@/shared/lib/refusal-text";

/** What the reader can do right now when a query failed (Review-Proven Rule 6). */
export type QueryRecovery = (onUnlocked: () => void) => ReactNode;

/**
 * State (d): the relay only answers authenticated reads — or this browser
 * cannot sign the challenge because its passkey is locked. Both meanings get
 * the same affordance, because both are fixed by the same tap.
 */
export const AUTH_REQUIRED_DESCRIPTION =
  "This server requires sign-in to load. Sign in with your passkey below and this page will retry automatically.";

/**
 * A failed query must read as a failure, not as an empty result.
 *
 * Every surface used to fall through to its own empty state when a relay query
 * failed — "no work items", "no agents", "no launches" — which is
 * indistinguishable from a genuinely empty workspace and offers no recovery.
 *
 * The failure itself has four shapes and says which one happened
 * (`lib/relay-failure.ts`):
 *
 * - **auth-required** (highest priority) — the relay demands sign-in, or this
 *   browser's passkey is locked so NIP-42 AUTH cannot be signed. Rendered with
 *   `AUTH_REQUIRED_DESCRIPTION` and the reader's `recovery` action; the
 *   caller's `onRetry` fires automatically when that action succeeds, so the
 *   page reloads itself instead of waiting for a second click.
 * - **answered** — the relay replied *and refused*. A refusal with plain
 *   words (a ban, an invite-only server, the request limit) says them;
 *   any other gets plain guidance (an unknown-kind refusal means the relay is
 *   older than this build — retrying will not help, upgrading will).
 * - **unanswered** — nobody replied (timeout, refused socket). Shown with
 *   the "may be offline" line and a retry: the reader's network or the relay
 *   process is what to check.
 * - **empty** is not here on purpose: success with zero events is the caller's
 *   own empty state, and this component only ever renders on failure.
 *
 * The evidence — the server's own wording and the address that was asked —
 * sits in a collapsed "Technical details" disclosure: people read the plain
 * words, and whoever helps them can open the rest.
 *
 * Callers keep owning `title` and the unanswered `description` — they know
 * what their page could not load; this component owns which of the four
 * happened and the evidence that proves it.
 */
export function QueryError({
  title,
  description,
  message,
  onRetry,
  testId = "query-error",
  error,
  relayUrl,
  kinds,
  recovery,
}: {
  title: string;
  /** Copy for the unanswered case (the caller knows what failed to load). */
  description: string;
  message?: string;
  onRetry?: () => void;
  testId?: string;
  /** The raw failure — drives the auth-required/answered/unanswered derivation. */
  error?: unknown;
  /** The relay endpoint the query was sent to, shown as evidence. */
  relayUrl?: string;
  /** Kinds the query asked for — named in the older-relay guidance. */
  kinds?: readonly number[];
  /**
   * Inline recovery (passkey sign-in). Receives the callback that retries the
   * failed query, so wiring the ceremony to an automatic retry takes one line.
   */
  recovery?: QueryRecovery;
}) {
  const outcome = error === undefined ? null : relayFailureOutcome(error);
  const authRequired = outcome === "auth-required";
  const answered = outcome === "answered";

  const relayMessage = error === undefined ? null : relayMessageOf(error);
  // An answered refusal replaces the caller's "did not answer" copy: saying
  // nobody replied about a relay that replied is the lie this component
  // exists to prevent. Its plain words come first; the guidance covers the rest.
  const shownDescription = authRequired
    ? AUTH_REQUIRED_DESCRIPTION
    : answered
      ? (plainRefusalText(relayMessage ?? "") ??
        relayFailureGuidance(relayMessage ?? "", kinds))
      : description;
  // The server's own wording, or the caller's, is evidence for whoever helps: kept under Technical details.
  const detailMessage = relayMessage ?? message;
  const retryNow = () => {
    onRetry?.();
  };

  return (
    <div
      className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center"
      data-testid={testId}
      data-outcome={outcome ?? "unanswered"}
      role="alert"
    >
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
      <p className="text-sm font-medium text-black dark:text-white">{title}</p>
      <p
        className="max-w-md text-sm text-black/60 dark:text-white/60"
        data-testid={`${testId}-description`}
      >
        {shownDescription}
      </p>
      {outcome === "unanswered" ? (
        <p
          className="max-w-md text-xs text-black/60 dark:text-white/60"
          data-testid={`${testId}-hint`}
        >
          The server may be offline or unreachable from this browser.
        </p>
      ) : null}
      {detailMessage || relayUrl ? (
        <details
          className="max-w-md text-xs text-black/60 dark:text-white/60"
          data-testid={`${testId}-details`}
        >
          <summary className="cursor-pointer select-none font-medium">
            Technical details
          </summary>
          {detailMessage ? (
            <p className="mt-1 break-words" data-testid={`${testId}-message`}>
              {detailMessage}
            </p>
          ) : null}
          {relayUrl ? (
            <p
              className="mt-1 break-all font-mono text-2xs"
              data-testid={`${testId}-relay`}
            >
              Server: {relayUrl}
            </p>
          ) : null}
        </details>
      ) : null}
      {recovery && error !== undefined ? (
        <div className="mt-1 flex w-full justify-center">
          {recovery(retryNow)}
        </div>
      ) : null}
      {onRetry ? (
        <button
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/15"
          data-testid={`${testId}-retry`}
          onClick={onRetry}
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      ) : null}
    </div>
  );
}

// Message text for an unknown thrown value, and the same failure as plain words for main copy.
export { errorMessage, readableError } from "@/shared/lib/readable-error";
