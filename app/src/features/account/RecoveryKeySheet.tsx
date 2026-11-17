import {
  exportPasskeyNsec,
  hasPasskeyIdentity,
  passkeyMode,
} from "@creaton/core/account/passkey-identity.ts";
import { recoveryExportFor } from "@creaton/core/account/recovery-key.ts";
import {
  closeRecoveryOffer,
  pendingRecoveryOffer,
  subscribeRecoveryOffer,
} from "@creaton/core/account/recovery-offer.ts";
import {
  existingUserPubkey,
  storedIdentityHex,
} from "@creaton/core/client/identity.ts";
import { Check, Copy } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";

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

/** The recovery key: the one thing that signs this account in on another device. Shown on request or after sign-up. */
export function RecoveryKeyPanel({ onSaved }: { onSaved: () => void }) {
  const recovery = currentExport();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const account = existingUserPubkey();
  const markSaved = () => {
    try {
      if (account) localStorage.setItem(BACKED_UP_KEY, account);
    } catch {
      // Storage refused: the reminder comes back next time.
    }
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
            {shown
              ? recovery.hex
              : `${recovery.hex.slice(0, 12)}…${recovery.hex.slice(-8)}`}
          </div>
          <div className="flex gap-2">
            <Button
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
          </div>
          <Button block data-testid="backup-done" onClick={markSaved}>
            I saved it
          </Button>
        </>
      ) : (
        <p
          className="glass rounded-xl p-3 text-sm"
          data-testid="backup-unavailable"
          role="status"
        >
          {recovery.kind === "locked"
            ? "Unlock with your passkey to show your recovery key."
            : "Your recovery key can't be read in this browser, so there is nothing to save here. Stay signed in until you have it."}
        </p>
      )}
    </div>
  );
}

/** Shows the recovery key once a passkey account is made (the offer made by sign-up, `recovery-offer.ts`). */
export function RecoveryOfferHost() {
  const offer = useSyncExternalStore(
    subscribeRecoveryOffer,
    pendingRecoveryOffer,
    pendingRecoveryOffer,
  );
  const close = () => {
    if (!offer) return;
    closeRecoveryOffer(offer);
    offer.onClose();
  };
  return (
    <Sheet
      description="A passkey signs in only on this device."
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={offer !== null}
      testId="backup-sheet"
      title="Save your recovery key"
    >
      <RecoveryKeyPanel onSaved={close} />
    </Sheet>
  );
}
