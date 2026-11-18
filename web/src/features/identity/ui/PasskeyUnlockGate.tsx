/**
 * One-touch unlock overlay for passkey-unlock mode (platforms without PRF,
 * e.g. iCloud Keychain): the passkey asserts possession (Touch ID) once per
 * session before the app is used. When the passkey does not answer, the
 * person can unlock with their recovery key instead, or sign out.
 */

import { useEffect, useRef, useState } from "react";
import { Fingerprint } from "lucide-react";

import { forgetIdentity } from "@/shared/lib/identity";
import {
  hasPasskeyIdentity,
  passkeyMode,
  signInPasskeyIdentity,
  isPasskeyActive,
  isPasskeyUnlocked,
  markPasskeyUnlocked,
  removePasskeyIdentity,
  RecoveryKeyMismatchError,
  unlockWithRecoveryKey,
} from "../lib/passkey-identity";
import { passkeyModeCopy } from "../lib/mode-copy";
import { passkeyUnlockProblem } from "../lib/passkey-problem";
import { parseRecoveryKey } from "../lib/recovery-key";
import { BACKED_UP_KEY, hasBackedUp } from "./RecoveryKeyDialog";
import { type FailureWords, errorMessage } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { FailureNote } from "@/shared/ui/failure-note";
import { IdentityDialog } from "./IdentityDialog";

export function PasskeyUnlockGate({ children }: { children: React.ReactNode }) {
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [key, setKey] = useState("");
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Unlocking with the key happens outside the passkey state the gate reads, so re-render once it is done.
  const [, setUnlockedByKey] = useState(false);
  // The auto-prompt runs once per mount: `unlock` is a new closure every render, and depending on it started ceremony
  // after ceremony (a cancelled prompt came straight back).
  const autoPrompted = useRef(false);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-only action; the ref keeps it to one prompt per mount
  useEffect(() => {
    if (!needed || autoPrompted.current) return;
    autoPrompted.current = true;
    // Auto-prompt once on boot; the touch gates the session. After that the person chooses: Unlock, the key, or sign out.
    void unlock();
  }, [needed]);

  // Opening the recovery-key form replaces the button that opened it: take focus to the field instead of losing it.
  useEffect(() => {
    if (showKeyForm) keyInputRef.current?.focus();
  }, [showKeyForm]);

  const unlockWithKey = () => {
    const hex = parseRecoveryKey(key);
    if (!hex) {
      setKeyProblem(
        "That doesn't look like a recovery key. Paste the whole key you saved.",
      );
      return;
    }
    try {
      const { pubkey } = unlockWithRecoveryKey(hex);
      // The key was typed in, so it is saved somewhere (D111: the flag names the account).
      localStorage.setItem(BACKED_UP_KEY, pubkey);
      setUnlockedByKey(true);
    } catch (e) {
      setKeyProblem(
        e instanceof RecoveryKeyMismatchError
          ? "That recovery key is for a different account. Paste the key you saved for this one."
          : "This browser could not save your account. Check that it allows site data, then try again.",
      );
    }
  };

  // The same as Sign out in the account menu: this browser forgets the account.
  const signOut = () => {
    removePasskeyIdentity();
    forgetIdentity();
    localStorage.removeItem(BACKED_UP_KEY);
    window.location.assign("/");
  };

  if (!needed) return <>{children}</>;

  return (
    <IdentityDialog
      cardClassName="w-full max-w-sm rounded-3xl bg-background p-6 text-center shadow-2xl"
      // Focus starts on the dialog itself, and returns there when Unlock disappears while the passkey is asked.
      labelledBy="passkey-unlock-title"
      refocusKey={unlocking}
      testId="passkey-unlock-dialog"
    >
      <div>
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
          <Fingerprint className="h-6 w-6 text-black/60 dark:text-white/60" />
        </div>
        <h1
          className="mt-3 text-lg font-semibold text-black dark:text-white"
          id="passkey-unlock-title"
        >
          {unlocking ? "Waiting for your passkey…" : "Sign in with passkey"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm with your passkey to unlock your account for this session.
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
        {showKeyForm ? (
          <form
            className="mt-4 text-left"
            data-testid="passkey-unlock-key-form"
            onSubmit={(event) => {
              event.preventDefault();
              unlockWithKey();
            }}
          >
            <label
              className="block text-sm font-medium"
              htmlFor="passkey-unlock-key"
            >
              Recovery key
            </label>
            <input
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
              data-testid="passkey-unlock-key"
              id="passkey-unlock-key"
              ref={keyInputRef}
              onChange={(event) => {
                setKey(event.target.value);
                setKeyProblem(null);
              }}
              spellCheck={false}
              type="password"
              value={key}
            />
            {keyProblem ? (
              <p
                className="mt-1 text-xs text-red-600 dark:text-red-400"
                data-testid="passkey-unlock-key-error"
                role="alert"
              >
                {keyProblem}
              </p>
            ) : null}
            <Button
              className="mt-2 w-full"
              data-testid="passkey-unlock-key-submit"
              size="sm"
              type="submit"
            >
              Sign in
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShowKeyForm(true)}
            className="mt-3 block w-full text-xs text-black/60 underline-offset-2 hover:underline dark:text-white/60"
            data-testid="passkey-unlock-use-key"
          >
            Sign in with my recovery key instead
          </button>
        )}
        <button
          type="button"
          onClick={() => setConfirmSignOut(true)}
          className="mt-2 block w-full text-xs text-black/60 underline-offset-2 hover:underline dark:text-white/60"
          data-testid="passkey-unlock-signout"
        >
          Sign out
        </button>
      </div>
      <ConfirmDialog
        confirmLabel={hasBackedUp() ? "Sign out" : "Sign out anyway"}
        description={
          hasBackedUp()
            ? "This browser forgets your account and your passkey. To sign back in, you need your recovery key."
            : "You haven't saved your recovery key. Without it this account is gone for good. Unlock first to save it."
        }
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={signOut}
        open={confirmSignOut}
        title="Sign out of this browser?"
      />
    </IdentityDialog>
  );
}
