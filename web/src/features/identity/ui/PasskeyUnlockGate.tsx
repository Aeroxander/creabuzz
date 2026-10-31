/**
 * One-touch unlock overlay for passkey-unlock mode (platforms without PRF,
 * e.g. iCloud Keychain): the passkey asserts possession (Touch ID) once per
 * session before the app is used.
 */

import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";

import {
  hasPasskeyIdentity,
  passkeyMode,
  signInPasskeyIdentity,
  isPasskeyActive,
  isPasskeyUnlocked,
  markPasskeyUnlocked,
} from "../lib/passkey-identity";
import { passkeyModeCopy } from "../lib/mode-copy";
import { passkeyUnlockProblem } from "../lib/passkey-problem";
import { type FailureWords, errorMessage } from "@/shared/lib/readable-error";
import { FailureNote } from "@/shared/ui/failure-note";
import { Overlay } from "@/shared/ui/portal";

export function PasskeyUnlockGate({ children }: { children: React.ReactNode }) {
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);

  const unlock = async () => {
    setUnlocking(true);
    setError(null);
    try {
      await signInPasskeyIdentity();
      markPasskeyUnlocked();
    } catch (e) {
      setError({ text: passkeyUnlockProblem(e), detail: errorMessage(e) });
      setUnlocking(false);
    }
  };

  const needed =
    hasPasskeyIdentity() &&
    passkeyMode() === "unlock" &&
    !isPasskeyActive() &&
    !isPasskeyUnlocked();

  useEffect(() => {
    if (!needed) return;
    // Auto-prompt once on boot; the touch gates the session.
    void unlock();
    // biome-ignore lint/correctness/useExhaustiveDependencies: boot-only action
  }, [needed, unlock]);

  if (!needed) return <>{children}</>;

  return (
    <Overlay className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 dark:bg-black/50">
      <div className="w-full max-w-sm rounded-3xl bg-background p-6 text-center shadow-2xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
          <Fingerprint className="h-6 w-6 text-black/60 dark:text-white/60" />
        </div>
        <h1 className="mt-3 text-lg font-semibold text-black dark:text-white">
          {unlocking ? "Waiting for your passkey…" : "Sign in with passkey"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Touch is required to unlock your account for this session.
        </p>
        <p
          className="mt-2 text-2xs text-black/60 dark:text-white/60"
          data-testid="passkey-unlock-mode-note"
        >
          {passkeyModeCopy(passkeyMode())}
        </p>
        {error ? (
          <FailureNote
            className="mt-2 text-xs text-red-600 dark:text-red-400"
            failure={error}
            testId="passkey-unlock-error"
          />
        ) : null}
        {!unlocking ? (
          <button
            type="button"
            onClick={() => void unlock()}
            className="mt-4 rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
            data-testid="passkey-unlock"
          >
            Unlock
          </button>
        ) : null}
      </div>
    </Overlay>
  );
}
