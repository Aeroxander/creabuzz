/**
 * `/link-device` — the browser half of the browser→desktop account handoff.
 * The desktop opens this page with a one-time key, a nonce and its callback;
 * the reader confirms which account would be shared, the account key is
 * encrypted to the one-time key, and the browser hands the ciphertext back to
 * the desktop app over the `creaton://` callback. Nothing is shared without
 * the explicit confirm below, and a link whose callback is not a `creaton://`
 * URL is refused outright.
 */
import * as React from "react";
import { getPublicKey } from "nostr-tools/pure";

import { parseLinkDeviceRequest } from "@creaton/core/link-device.ts";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import {
  identityStorageState,
  nsecToBytes,
  rotateIdentity,
} from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  buildLinkDeviceRedirect,
  linkDeviceAccountSecretHex,
} from "../lib/link-device-flow";
import {
  hasPasskeyIdentity,
  passkeyStoredPubkey,
  signInPasskeyIdentity,
} from "../lib/passkey-identity";

type Phase =
  | "invalid"
  | "no-identity"
  | "unreadable"
  | "confirm"
  | "linked"
  | "cancelled"
  | "error";

export function LinkDevicePage() {
  const request = React.useMemo(
    () => parseLinkDeviceRequest(window.location.search),
    [],
  );
  const [phase, setPhase] = React.useState<Phase>(() => {
    if (!request.ok) return "invalid";
    // A registered passkey goes straight to the desktop-framed confirm —
    // there is no separate "log in to the web app" step. A locked passkey
    // unlocks inside the confirm action below, so the single button is the
    // only passkey popup and nothing is shared without that explicit click.
    if (hasPasskeyIdentity()) return "confirm";
    // Otherwise this page must NOT create one. Only proceed when a stored
    // identity already exists — a read-only visitor is never handed a
    // brand-new, un-backed-up key here.
    const state = identityStorageState();
    if (state === "unreadable") return "unreadable";
    return state === "ready" ? "confirm" : "no-identity";
  });
  const [npub, setNpub] = React.useState<string | null>(null);
  const [handoffUrl, setHandoffUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [signInError, setSignInError] = React.useState<string | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);

  const secretHex = React.useMemo(
    () => (phase === "confirm" ? linkDeviceAccountSecretHex() : null),
    [phase],
  );
  const pubkey = React.useMemo(() => {
    if (secretHex) {
      try {
        return getPublicKey(nsecToBytes(secretHex));
      } catch {
        return null;
      }
    }
    // Locked passkey: show who would be linked before any popup, from the
    // stored public material — the confirm click is the unlock ceremony.
    return passkeyStoredPubkey();
  }, [secretHex]);
  const { data: profiles } = useProfiles(pubkey ? [pubkey] : []);
  const name = resolveUserName(
    pubkey ? profiles?.[pubkey] : undefined,
    pubkey ?? "",
  );

  const lockedPasskey = !secretHex && hasPasskeyIdentity();

  const confirm = async () => {
    if (!request.ok || busy) return;
    setBusy(true);
    setSignInError(null);
    try {
      // Locked passkey unlocks here: the single "login to desktop" popup.
      // The click itself is the explicit consent — nothing was shared before.
      let hex = secretHex;
      if (!hex && hasPasskeyIdentity()) {
        try {
          await signInPasskeyIdentity();
        } catch {
          setSignInError(
            "Sign-in did not finish. Try again, or open the link from the desktop app once more.",
          );
          return;
        }
        hex = linkDeviceAccountSecretHex();
      }
      if (!hex) {
        setPhase("error");
        return;
      }
      try {
        const handoff = buildLinkDeviceRedirect({
          request: request.value,
          secretKeyHex: hex,
        });
        setNpub(handoff.npub);
        // Keep the callback so the "linked" screen can offer the retry link:
        // a one-shot programmatic redirect is silently dropped whenever the
        // browser blocks a custom-scheme navigation or no handler is registered
        // yet, and the user would otherwise be stranded with no way back
        // (repo rule: never hide the only recovery affordance). The URL is only
        // ever an `href` — it carries the encrypted payload and is never shown.
        setHandoffUrl(handoff.url);
        setPhase("linked");
        window.location.assign(handoff.url);
      } catch {
        // Generic on purpose: nothing about the key or payload is echoed back.
        setPhase("error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6 py-10">
      {phase === "invalid" ? (
        <section role="alert" data-testid="link-device-invalid">
          <h1 className="text-base font-semibold">This link is not valid</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It is missing details or is not a desktop link. Nothing was shared.
            Ask the desktop app to show a new link, then open it again.
          </p>
          <a className="mt-4 inline-block text-sm underline" href="/">
            Go to Creaton
          </a>
        </section>
      ) : null}

      {phase === "no-identity" ? (
        <section data-testid="link-device-no-identity">
          <h1 className="text-base font-semibold">Create your account first</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            There is no account on this browser yet, so there is nothing to link
            to the desktop app. Sign in or create your account, then open the
            desktop link again.
          </p>
          <a className="mt-4 inline-block text-sm underline" href="/">
            Go to Creaton
          </a>
        </section>
      ) : null}

      {phase === "unreadable" ? (
        <section role="alert" data-testid="link-device-unreadable">
          <h1 className="text-base font-semibold">
            Your saved account can&rsquo;t be read
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This browser has a saved account but it can&rsquo;t be opened, so
            nothing was shared with the desktop app. If you have your recovery
            key, use it to sign in on the app. Otherwise you can start over with
            a new account. This discards the unreadable one for good.
          </p>
          {confirmReset ? (
            <div className="mt-4 rounded-md border border-black/10 p-3 text-sm dark:border-white/10">
              <p>
                Starting over removes the unreadable saved account and creates a
                new one. This cannot be undone.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  data-testid="link-device-reset-confirm"
                  className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
                  onClick={() => {
                    rotateIdentity();
                    window.location.assign("/");
                  }}
                >
                  Start over
                </button>
                <button
                  type="button"
                  data-testid="link-device-reset-cancel"
                  className="rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium dark:border-white/20"
                  onClick={() => setConfirmReset(false)}
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="link-device-reset"
              className="mt-4 rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium dark:border-white/20"
              onClick={() => setConfirmReset(true)}
            >
              Start over
            </button>
          )}
          <a className="mt-4 ml-2 inline-block text-sm underline" href="/">
            Go to Creaton
          </a>
        </section>
      ) : null}

      {phase === "confirm" && pubkey ? (
        <section data-testid="link-device-confirm-panel">
          <h1 className="text-base font-semibold">
            Log in to desktop as @{name}?
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {lockedPasskey
              ? "One passkey check logs this desktop in. Nothing is shared until you confirm here."
              : "The desktop app will be able to act as this account. Only confirm on a desktop you trust."}
          </p>
          <div
            className="mt-3 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/10"
            data-testid="link-device-identity"
          >
            <span className="font-medium">{name}</span>{" "}
            <span className="text-2xs text-muted-foreground">
              {truncatePubkey(pubkey)}
            </span>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              data-testid="link-device-confirm"
              disabled={busy}
              className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
              onClick={() => void confirm()}
            >
              {busy
                ? "Waiting for your passkey…"
                : lockedPasskey
                  ? "Continue with passkey"
                  : "Log in desktop"}
            </button>
            <button
              type="button"
              data-testid="link-device-cancel"
              disabled={busy}
              className="rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-white/20"
              onClick={() => setPhase("cancelled")}
            >
              Cancel
            </button>
          </div>
          {signInError ? (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {signInError}
            </p>
          ) : null}
        </section>
      ) : null}

      {phase === "linked" ? (
        <section role="status" data-testid="link-device-linked">
          <h1 className="text-base font-semibold">
            Link sent. Finish in your desktop app
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The link was opened on this device. Finish the steps in the desktop
            app to sign in there with this account.
          </p>
          {handoffUrl ? (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                Nothing opened? Use this button to open the desktop app again.
                It works only once, and only on this device.
              </p>
              <a
                className="mt-2 inline-block rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
                data-testid="link-device-open-desktop"
                href={handoffUrl}
              >
                Open the desktop app
              </a>
            </>
          ) : null}
          <p
            className="mt-3 break-all rounded-md border border-black/10 px-3 py-2 font-mono text-2xs dark:border-white/10"
            data-testid="link-device-npub"
          >
            {npub}
          </p>
        </section>
      ) : null}

      {phase === "cancelled" ? (
        <section data-testid="link-device-cancelled">
          <h1 className="text-base font-semibold">Link cancelled</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing was shared with the desktop app.
          </p>
          <a className="mt-4 inline-block text-sm underline" href="/">
            Go to Creaton
          </a>
        </section>
      ) : null}

      {phase === "error" ? (
        <section role="alert" data-testid="link-device-error">
          <h1 className="text-base font-semibold">The link did not work</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The link could not be prepared, so nothing was shared. Try again
            from the desktop app.
          </p>
          <a className="mt-4 inline-block text-sm underline" href="/">
            Go to Creaton
          </a>
        </section>
      ) : null}
    </main>
  );
}
