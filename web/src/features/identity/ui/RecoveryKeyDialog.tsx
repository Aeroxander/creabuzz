/**
 * Saving the account's recovery key: the one dialog for it, opened from the account menu, from signing out without one,
 * and once right after a passkey account is made (a passkey signs in only in the browser that made it, so another
 * device, or this one after its site data is cleared, needs the key).
 */

import { type RefObject, useRef, useState } from "react";
import { Check, Copy, Download, Fingerprint } from "lucide-react";

import { APP_NAME } from "@/shared/constants/brand";
import { existingUserPubkey, storedIdentityHex } from "@/shared/lib/identity";
import { Overlay } from "@/shared/ui/portal";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";

import {
  backedUpFor,
  type RecoveryExport,
  recoveryExportFor,
  recoveryKeyFileName,
} from "../lib/recovery-key";
import {
  hasPasskeyIdentity,
  passkeyMode,
  passkeySecretKey,
  signInPasskeyIdentity,
} from "../lib/passkey-identity";
import { passkeyUnlockProblem } from "../lib/passkey-problem";

export const BACKED_UP_KEY = "buzz.identity.backedUp";

/** How a passkey registered here holds the key, or null without one. */
function passkeyHolding(): "prf" | "unlock" | null {
  return hasPasskeyIdentity() ? passkeyMode() : null;
}

/** Whether this account's recovery key was saved from this browser (D111: per account, after a real export). */
export function hasBackedUp(): boolean {
  try {
    return backedUpFor(
      localStorage.getItem(BACKED_UP_KEY),
      existingUserPubkey(),
      passkeyHolding(),
    );
  } catch {
    return true;
  }
}

export function markBackedUp(account: string) {
  try {
    localStorage.setItem(BACKED_UP_KEY, account.toLowerCase());
  } catch {
    // Not remembered: the reminder simply stays.
  }
}

/**
 * This account's recovery key, from wherever this browser holds it (`recoveryExportFor`): the one source for every
 * backup the app offers, so none can save an empty key or another identity's.
 */
export function currentRecovery(account: string): RecoveryExport {
  let stored: string | null = null;
  try {
    stored = storedIdentityHex();
  } catch {
    stored = null;
  }
  const secret = passkeySecretKey();
  return recoveryExportFor(account || null, {
    passkey: passkeyHolding(),
    passkeySecret: secret
      ? Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        )
      : null,
    stored,
  });
}

/** Copy the key, and count it as saved only once the clipboard took it. Resolves true when it was copied. */
export function copyRecoveryKey(
  hex: string,
  account: string,
): Promise<boolean> {
  const write = navigator.clipboard?.writeText(hex);
  if (!write) {
    void import("sonner").then(({ toast }) =>
      toast.error("Couldn't copy it. Try Download instead."),
    );
    return Promise.resolve(false);
  }
  return write
    .then(() => {
      markBackedUp(account);
      void import("sonner").then(({ toast }) =>
        toast.success("Recovery key copied"),
      );
      return true;
    })
    .catch(() => {
      void import("sonner").then(({ toast }) =>
        toast.error("Couldn't copy it. Try Download instead."),
      );
      return false;
    });
}

export function RecoveryKeyDialog({
  account,
  onClose,
  intro,
  closeLabel = "Close",
  returnFocus,
}: {
  account: string;
  onClose: () => void;
  /** Where focus goes on close when whatever opened it is gone by then (a menu item in a menu that closed). */
  returnFocus?: RefObject<HTMLElement | null>;
  /** A line above the usual words, e.g. that the account was just made. */
  intro?: string;
  closeLabel?: string;
}) {
  const [revealKey, setRevealKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // The key comes from module state (the passkey session): bumping this re-reads it after an unlock.
  const [, setGeneration] = useState(0);
  const recovery = currentRecovery(account);
  // It can open unasked (right after sign-up): bring keyboard and screen-reader focus into it (the dialog itself, so its
  // title is read first), keep Tab inside it while it is open, give focus back to what opened it on close, and let
  // Escape close it.
  const panel = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panel, { initialFocus: panel, returnFocus });

  const unlock = async () => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      await signInPasskeyIdentity();
      setGeneration((n) => n + 1);
    } catch (error) {
      setUnlockError(passkeyUnlockProblem(error));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <Overlay
      className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50"
      data-testid="backup-dialog"
    >
      <div
        aria-labelledby="backup-dialog-title"
        aria-modal="true"
        className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl outline-none"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Only the dialog closes: the account menu it may have opened from stays, with focus back on its item.
          event.stopPropagation();
          onClose();
        }}
        ref={panel}
        role="dialog"
        tabIndex={-1}
      >
        <h3
          className="text-base font-semibold text-black dark:text-white"
          id="backup-dialog-title"
        >
          Save your recovery key
        </h3>
        {intro ? (
          <p className="mt-1 text-sm font-medium text-foreground">{intro}</p>
        ) : null}
        <p className="mt-1 text-sm text-muted-foreground">
          This secret key is your account: anyone who has it can act as you.
          Keep it somewhere private. You need it to sign in on another device,
          or if this browser is ever cleared.
        </p>
        {recovery.kind === "ready" ? (
          <div className="mt-3 rounded-md border border-input bg-black/[0.03] p-2 font-mono text-2xs break-all text-black/70 dark:bg-white/5 dark:text-white/70">
            {revealKey
              ? recovery.hex
              : `${recovery.hex.slice(0, 12)}…${recovery.hex.slice(-8)}`}
          </div>
        ) : (
          <p
            className="mt-3 rounded-md bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-200"
            data-testid="backup-unavailable"
            role="status"
          >
            {recovery.kind === "locked"
              ? "Unlock with your passkey to show your recovery key."
              : "Your recovery key can't be read in this browser, so there is nothing to save here. Stay signed in until you have it."}
          </p>
        )}
        {unlockError ? (
          <p
            className="mt-2 text-xs text-red-600 dark:text-red-400"
            role="alert"
          >
            {unlockError}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {recovery.kind === "ready" ? (
            <>
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
              >
                {revealKey ? "Hide" : "Reveal"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void copyRecoveryKey(recovery.hex, account).then(setCopied)
                }
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                data-testid="backup-copy"
              >
                {copied ? (
                  <>
                    <Check aria-hidden className="h-3 w-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy aria-hidden className="h-3 w-3" /> Copy
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([recovery.hex], {
                    type: "text/plain",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = recoveryKeyFileName(APP_NAME, account);
                  a.click();
                  URL.revokeObjectURL(url);
                  markBackedUp(account);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
                data-testid="backup-download"
              >
                <Download aria-hidden className="h-3 w-3" /> Download
              </button>
            </>
          ) : recovery.kind === "locked" ? (
            <button
              type="button"
              disabled={unlocking}
              onClick={() => void unlock()}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
              data-testid="backup-unlock"
            >
              <Fingerprint aria-hidden className="h-3 w-3" />{" "}
              {unlocking ? "Waiting for your passkey…" : "Unlock"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground"
            data-testid="backup-close"
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
