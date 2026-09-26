import { useEffect, useRef, useState } from "react";

import { getUserSigningBlockedReason } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";

import { explainPasskeyError } from "../lib/passkey";
import {
  hasPasskeyIdentity,
  isPasskeyActive,
  onPasskeySessionChange,
  setupPasskey,
  signInPasskeyIdentity,
} from "../lib/passkey-identity";
import { deriveSignRecovery } from "../lib/sign-recovery";

/**
 * The failure message *and* the way out, rendered together.
 *
 * Pass the error a gated action produced; when the reason is a locked passkey
 * this renders the unlock/create action beside it instead of leaving the
 * refusal as a terminal state (Review-Proven Rule 6), and runs the ceremony
 * in place — `onUnlocked` fires on success so the caller can resume the
 * intent it was about to perform. When the failure is something else the
 * message renders unchanged, so this component can replace every bare
 * `<p>{error}</p>` in a signing-gated dialog without changing their
 * behaviour.
 *
 * The reader can also unlock somewhere else entirely (the profile menu's boot
 * prompt, the unlock gate). `autoResume` says whether that unlock should
 * resume this surface too: query states pass it so a sign-in anywhere reloads
 * the page, dialogs leave it off so they never submit themselves.
 */
export function SignRecovery({
  message,
  onUnlocked,
  displayName = "Buzz reader",
  className = "",
  testId = "sign-recovery",
  showHeadline = true,
  messageTestId,
  autoResume = false,
}: {
  /** The failure to render (null/undefined renders nothing). */
  message?: string | null;
  /** Called after the ceremony succeeds — resume the pending action here. */
  onUnlocked?: () => void;
  /** userLabel for the create-a-passkey branch. */
  displayName?: string;
  className?: string;
  testId?: string;
  /**
   * Render the recovery headline when no `message` was passed. Set false when
   * the host (e.g. `QueryError`) already printed the failure, so the sentence
   * is not shown twice beside one button.
   */
  showHeadline?: boolean;
  /** Override for the message element's testid (keeps a host's own hooks). */
  messageTestId?: string;
  /** Resume the action when the reader unlocks from *another* surface. */
  autoResume?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The recovery is derived from module state (the passkey session), not from
  // props — bumping this counter is how a completed ceremony re-derives it.
  const [, setGeneration] = useState(0);

  const recovery = deriveSignRecovery({
    registered: hasPasskeyIdentity(),
    active: isPasskeyActive(),
    blockedReason: getUserSigningBlockedReason(),
  });

  // True while a recovery is on screen; the blocked -> unlocked edge is what
  // `autoResume` acts on, and clearing it before an explicit resume keeps the
  // two paths from firing twice.
  const wasRecovering = useRef(recovery !== null);
  const resume = () => {
    wasRecovering.current = false;
    onUnlocked?.();
  };

  // Re-derive on any passkey session change (boot sign-in, unlock gate,
  // profile menu) — this component cannot see those otherwise.
  useEffect(
    () => onPasskeySessionChange(() => setGeneration((n) => n + 1)),
    [],
  );

  useEffect(() => {
    if (recovery !== null) {
      wasRecovering.current = true;
      return;
    }
    if (wasRecovering.current && autoResume) resume();
  });

  const text = message ?? (showHeadline ? (recovery?.headline ?? null) : null);
  if (!recovery && text === null) return null;

  const run = () => {
    if (!recovery || busy) return;
    setBusy(true);
    setActionError(null);
    void (async () => {
      try {
        if (recovery.action === "signin") {
          await signInPasskeyIdentity();
        } else {
          await setupPasskey(displayName);
        }
        setGeneration((n) => n + 1);
        resume();
      } catch (error) {
        setActionError(explainPasskeyError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className={className} data-testid={testId}>
      {text !== null ? (
        <p
          className="text-sm text-red-600 dark:text-red-400"
          data-testid={messageTestId ?? `${testId}-message`}
          role="alert"
        >
          {text}
        </p>
      ) : null}
      {recovery ? (
        <>
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            {recovery.helper}
          </p>
          <Button
            className="mt-2"
            data-testid={`${testId}-action`}
            disabled={busy}
            onClick={run}
            size="sm"
            type="button"
          >
            {busy ? "Waiting for your passkey…" : recovery.cta}
          </Button>
          {actionError ? (
            <p
              className="mt-1 text-xs text-red-600 dark:text-red-400"
              data-testid={`${testId}-error`}
            >
              {actionError}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
