import {
  exportPasskeyNsec,
  hasPasskeyIdentity,
  passkeyMode,
} from "@creaton/core/account/passkey-identity.ts";
import {
  recoveryExportFor,
  recoveryKeyFileName,
} from "@creaton/core/account/recovery-key.ts";
import { APP_NAME } from "@creaton/core/brand.ts";
import {
  existingUserPubkey,
  storedIdentityHex,
} from "@creaton/core/client/identity.ts";
import { Check, Copy, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";
import { UnlockPress } from "./UnlockPress";

/** Set once this account's recovery key was saved (the same key web/ uses). */
export const BACKED_UP_KEY = "buzz.identity.backedUp";

function currentExport() {
  let stored: string | null = null;
  try {
    stored = storedIdentityHex();
  } catch {
    stored = null;
  }
  return recoveryExportFor(existingUserPubkey(), {
    passkey: hasPasskeyIdentity() ? passkeyMode() : null,
    passkeySecret: exportPasskeyNsec(),
    stored,
  });
}

/** Said in place of the key until the person presses Reveal: the key is never drawn without that press, not even in part. */
export const KEY_MASK = "•••• •••• •••• •••• •••• ••••";

/**
 * Save `key` as a small text file named for the product and the account (never anything else), from a local address that is
 * dropped a moment later. Nothing is logged and nothing leaves the phone.
 */
export function downloadRecoveryKey(key: string, account: string): void {
  const url = URL.createObjectURL(new Blob([key], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = recoveryKeyFileName(APP_NAME, account);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** The recovery key: the one thing that signs this account in on another device. Shown on request or after sign-up. */
export function RecoveryKeyPanel({ onSaved }: { onSaved: () => void }) {
  const recovery = currentExport();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const account = existingUserPubkey();
  const remember = () => {
    try {
      if (account) localStorage.setItem(BACKED_UP_KEY, account);
    } catch {
      // Storage refused: the reminder comes back next time.
    }
  };
  const markSaved = () => {
    remember();
    onSaved();
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        This secret key is your account: anyone who has it can act as you. Keep
        it somewhere private. You need it to sign in on another device, or if
        this browser is ever cleared.
      </p>
      {recovery.kind === "ready" ? (
        <>
          <div
            className="glass num break-all rounded-xl p-3 text-sm"
            data-testid="backup-key"
          >
            {shown ? recovery.hex : KEY_MASK}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="backup-reveal"
              onClick={() => setShown((v) => !v)}
              size="sm"
              variant="secondary"
            >
              {shown ? "Hide" : "Reveal"}
            </Button>
            <Button
              data-testid="backup-copy"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(recovery.hex)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
              size="sm"
              variant="secondary"
            >
              {copied ? (
                <Check aria-hidden="true" size={16} />
              ) : (
                <Copy aria-hidden="true" size={16} />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              data-testid="backup-download"
              onClick={() => {
                if (!account) return;
                downloadRecoveryKey(recovery.hex, account);
                remember();
              }}
              size="sm"
              variant="secondary"
            >
              <Download aria-hidden="true" size={16} />
              Download
            </Button>
          </div>
          <Button block data-testid="backup-done" onClick={markSaved}>
            I saved it
          </Button>
        </>
      ) : (
        <>
          <p
            className="glass rounded-xl p-3 text-sm"
            data-testid="backup-unavailable"
            role="status"
          >
            {recovery.kind === "locked"
              ? "Unlock with your passkey to show your recovery key."
              : "Your recovery key can't be read in this browser, so there is nothing to save here. Stay signed in until you have it."}
          </p>
          {recovery.kind === "locked" ? (
            <div className="flex flex-wrap">
              <UnlockPress testId="backup-unlock" />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
