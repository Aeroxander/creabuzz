import { useEffect, useState } from "react";

import { hasStoredIdentity } from "@/shared/lib/identity";

import {
  ACCOUNT_READY_EVENT,
  SIGN_IN_EVENT,
  SIGN_UP_EVENT,
} from "../lib/account-copy";
import { hasPasskeyIdentity } from "../lib/passkey-identity";
import { OnboardingDialog } from "./OnboardingDialog";

/**
 * The one place the sign-up and sign-in dialogs live. Anything that needs an account (the top bar, Follow, Start, a
 * promise) asks with `SIGN_UP_EVENT` or `SIGN_IN_EVENT`, and this opens the dialog.
 *
 * It is mounted once, beside the app's top bar and tab bar and not inside either, so swapping one for the other at
 * 768 px (a phone turned sideways, a window dragged narrower) does not close a dialog someone is part way through. What
 * was typed or ticked lives in the dialog's own state: it survives that swap and is gone when the dialog is dismissed.
 *
 * A person who already has an account is never shown the dialog.
 */
export function AuthDialogsHost() {
  const [dialog, setDialog] = useState<"create" | "signin" | null>(null);

  useEffect(() => {
    const open = (way: "create" | "signin") => () => {
      if (hasStoredIdentity() || hasPasskeyIdentity()) return;
      setDialog(way);
    };
    const signUp = open("create");
    const signIn = open("signin");
    window.addEventListener(SIGN_UP_EVENT, signUp);
    window.addEventListener(SIGN_IN_EVENT, signIn);
    return () => {
      window.removeEventListener(SIGN_UP_EVENT, signUp);
      window.removeEventListener(SIGN_IN_EVENT, signIn);
    };
  }, []);

  if (dialog === null) return null;
  return (
    <OnboardingDialog
      key={dialog}
      onCancel={() => setDialog(null)}
      onDone={() => {
        // Reload so the fresh profile (kind 0) renders in the chip.
        window.location.reload();
      }}
      onPasskeyDone={() => {
        // Passkey setup re-renders in place: no reload, no extra ceremony. The session is already active with the
        // derived key, so the account menu and the top bar are told the account exists.
        setDialog(null);
        window.dispatchEvent(new Event(ACCOUNT_READY_EVENT));
      }}
      startOn={dialog}
    />
  );
}
