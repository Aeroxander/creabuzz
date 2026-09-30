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
import { nsecToBytes } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  buildLinkDeviceRedirect,
  linkDeviceAccountSecretHex,
} from "../lib/link-device-flow";
import {
  hasPasskeyIdentity,
  isPasskeyUnlocked,
  signInPasskeyIdentity,
} from "../lib/passkey-identity";

type Phase =
  | "invalid"
  | "sign-in"
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
    return hasPasskeyIdentity() && !isPasskeyUnlocked() ? "sign-in" : "confirm";
  });
  const [npub, setNpub] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [signInError, setSignInError] = React.useState<string | null>(null);

  const secretHex = React.useMemo(
    () => (phase === "confirm" ? linkDeviceAccountSecretHex() : null),
    [phase],
  );
  const pubkey = React.useMemo(() => {
    if (!secretHex) return null;
    try {
      return getPublicKey(nsecToBytes(secretHex));
    } catch {
      return null;
    }
  }, [secretHex]);
  const { data: profiles } = useProfiles(pubkey ? [pubkey] : []);
  const name = resolveUserName(
    pubkey ? profiles?.[pubkey] : undefined,
    pubkey ?? "",
  );

  const confirm = () => {
    if (!request.ok || !secretHex) return;
    try {
      const handoff = buildLinkDeviceRedirect({
        request: request.value,
        secretKeyHex: secretHex,
      });
      setNpub(handoff.npub);
      setPhase("linked");
      window.location.assign(handoff.url);
    } catch {
      // Generic on purpose: nothing about the key or payload is echoed back.
      setPhase("error");
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

      {phase === "sign-in" ? (
        <section data-testid="link-device-sign-in">
          <h1 className="text-base font-semibold">Sign in to continue</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A passkey protects this account. Sign in to choose which account to
            link to the desktop app.
          </p>
          <button
            type="button"
            data-testid="link-device-passkey"
            disabled={busy}
            className="mt-4 rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            onClick={() => {
              setBusy(true);
              setSignInError(null);
              signInPasskeyIdentity()
                .then(() => setPhase("confirm"))
                .catch(() =>
                  setSignInError(
                    "Sign-in did not complete. Try again, or open the link from the desktop app once more.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Sign in with passkey
          </button>
          {signInError ? (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {signInError}
            </p>
          ) : null}
        </section>
      ) : null}

      {phase === "confirm" && pubkey ? (
        <section data-testid="link-device-confirm-panel">
          <h1 className="text-base font-semibold">
            Link this desktop to @{name}?
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The desktop app will be able to sign as this account. Only confirm
            on a desktop you trust.
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
              className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
              onClick={confirm}
            >
              Link this desktop
            </button>
            <button
              type="button"
              data-testid="link-device-cancel"
              className="rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium dark:border-white/20"
              onClick={() => setPhase("cancelled")}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {phase === "linked" ? (
        <section role="status" data-testid="link-device-linked">
          <h1 className="text-base font-semibold">Desktop linked</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This account is now signed in on the desktop app. Both this page and
            the desktop show the same account address.
          </p>
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
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The link could not be prepared, so nothing was shared. Try again
            from the desktop app.
          </p>
        </section>
      ) : null}
    </main>
  );
}
