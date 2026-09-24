/**
 * Passkey ceremony prototype (wave 4): one registration ceremony, both
 * identity roots — the PRF-derived Nostr key (page memory only) and the
 * passkey's own secp256r1 key as the future smart-wallet (ZeroDev Kernel)
 * owner. Register → reload → unlock exercises the real `navigator.credentials`
 * surface; `/identity-demo` mounts it for that (and for manual Touch ID runs).
 */

import { useState } from "react";
import { Fingerprint, KeyRound } from "lucide-react";

import { explainPasskeyError, type PasskeyIdentity } from "../lib/passkey";
import {
  exportPasskeyNsec,
  hasPasskeyIdentity,
  isPasskeyActive,
  passkeyIdentity,
  passkeyMode,
  passkeyStoredPubkey,
  removePasskeyIdentity,
  setupPasskey,
  signInPasskeyIdentity,
} from "../lib/passkey-identity";
import { UserOpDemoCard } from "./UserOpDemoCard";

type Busy = "create" | "unlock" | null;

function webAuthnAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.credentials?.create) &&
    (typeof globalThis.isSecureContext !== "boolean" ||
      globalThis.isSecureContext)
  );
}

function RootsTable({ identity }: { identity: PasskeyIdentity }) {
  return (
    <dl className="mt-3 space-y-2 text-left">
      <div>
        <dt className="text-xs text-black/60 dark:text-white/60">
          Nostr identity (npub, hex) — lives in page memory only
        </dt>
        <dd
          className="font-mono text-2xs break-all text-black/80 dark:text-white/80"
          data-testid="passkey-nostr-pubkey"
        >
          {identity.nostr.pubkeyHex}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-black/60 dark:text-white/60">
          Smart-wallet owner (secp256r1, uncompressed) — the future Kernel owner
          (wave 4b)
        </dt>
        <dd
          className="font-mono text-2xs break-all text-black/80 dark:text-white/80"
          data-testid="passkey-r1-key"
        >
          {identity.evmOwner.r1UncompressedHex}
        </dd>
      </div>
      {identity.evmOwner.addressPreview ? (
        <div>
          <dt className="text-xs text-black/60 dark:text-white/60">
            Owner key address (preview — the Kernel account address is assigned
            on deployment)
          </dt>
          <dd
            className="font-mono text-2xs break-all text-black/80 dark:text-white/80"
            data-testid="passkey-r1-address"
          >
            {identity.evmOwner.addressPreview}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export function PasskeyCeremonyPage() {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const [envOk] = useState(webAuthnAvailable);

  const registered = hasPasskeyIdentity();
  const identity = passkeyIdentity();
  const active = isPasskeyActive();
  const mode = passkeyMode();

  const run = async (
    which: Exclude<Busy, null>,
    fn: () => Promise<unknown>,
  ) => {
    setBusy(which);
    setError(null);
    setCopied(false);
    try {
      await fn();
      setRefresh((n) => n + 1);
      setBusy(null);
    } catch (e) {
      setError(explainPasskeyError(e));
      setBusy(null);
    }
  };

  const missingOwnerRoot = registered && !identity;

  return (
    <div className="flex min-h-full flex-col items-center justify-center p-4">
      <div
        className="w-full max-w-lg rounded-3xl bg-background p-6 shadow-2xl"
        data-testid="passkey-ceremony"
        data-refresh={refresh}
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
          <Fingerprint
            className="h-6 w-6 text-black/60 dark:text-white/60"
            aria-hidden="true"
          />
        </div>
        <h1 className="mt-3 text-center text-lg font-semibold tracking-tight text-black dark:text-white">
          {busy ? "Waiting for your passkey…" : "Passkey identity"}
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          One passkey creates both identity roots: a Nostr key derived here in
          page memory, and the passkey&apos;s own secp256r1 key as the owner of
          the future smart wallet. Nothing secret is stored on this browser.
        </p>

        {envOk ? null : (
          <p
            className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            role="alert"
            data-testid="passkey-env-warning"
          >
            Passkeys need the WebAuthn API in a secure context. Open this page
            over https, or http://localhost in development — this browser
            reports neither, so no ceremony can run here.
          </p>
        )}

        <div className="mt-4 space-y-2">
          {!registered ? (
            <button
              type="button"
              onClick={() =>
                void run("create", () => setupPasskey("Creaton user"))
              }
              disabled={!envOk || busy !== null}
              aria-busy={busy === "create"}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              data-testid="passkey-create"
            >
              <Fingerprint className="h-4 w-4" aria-hidden="true" />
              {busy === "create"
                ? "Waiting for your passkey…"
                : "Create passkey"}
            </button>
          ) : null}

          {registered && !active ? (
            <button
              type="button"
              onClick={() => void run("unlock", () => signInPasskeyIdentity())}
              disabled={!envOk || busy !== null}
              aria-busy={busy === "unlock"}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              data-testid="passkey-signin"
            >
              <Fingerprint className="h-4 w-4" aria-hidden="true" />
              {busy === "unlock"
                ? "Waiting for your passkey…"
                : "Continue with Touch ID / platform authenticator"}
            </button>
          ) : null}
        </div>

        {error ? (
          <p
            className="mt-3 text-xs text-red-600 dark:text-red-400"
            role="alert"
            data-testid="passkey-error"
          >
            {error}
          </p>
        ) : null}

        {registered ? (
          <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
            <p className="text-xs text-black/60 dark:text-white/60">
              Registered on this browser — mode{" "}
              <span className="font-medium" data-testid="passkey-mode">
                {mode ?? "unknown"}
              </span>
              {mode === "unlock"
                ? " (passkey gates the touch; the key stays in this browser)"
                : " (Nostr key derived from the passkey's PRF output)"}
              . Secret key:{" "}
              {active
                ? "in page memory now"
                : "not in memory — touch to re-derive"}
              .
            </p>

            {missingOwnerRoot ? (
              <p
                className="mt-2 text-xs text-amber-700 dark:text-amber-300"
                data-testid="passkey-r1-missing"
              >
                This registration predates wallet-owner capture. Create a new
                passkey to also get the smart-wallet owner root.
              </p>
            ) : identity ? (
              <RootsTable identity={identity} />
            ) : null}

            {active ? (
              <div className="mt-3 rounded-md bg-black/[0.03] p-3 text-xs text-black/70 dark:bg-white/5 dark:text-white/70">
                <p className="flex items-start gap-1.5">
                  <KeyRound
                    className="mt-0.5 h-3 w-3 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    Back up your key (nsec) now — it is the one-time, portable
                    recovery for this identity. Losing the passkey without this
                    backup loses the identity for good.
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const nsec = exportPasskeyNsec();
                    if (!nsec) return;
                    void navigator.clipboard?.writeText(nsec).then(() => {
                      setCopied(true);
                    });
                  }}
                  className="mt-2 rounded-full border border-input bg-background px-3 py-1 text-xs font-medium"
                  data-testid="passkey-backup"
                >
                  {copied ? "Key copied" : "Copy key backup"}
                </button>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => {
                removePasskeyIdentity();
                setError(null);
                setCopied(false);
                setRefresh((n) => n + 1);
              }}
              disabled={busy !== null}
              className="mt-3 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="passkey-remove"
            >
              Remove passkey from this browser
            </button>
          </div>
        ) : (
          <p className="mt-4 text-center text-xs text-black/60 dark:text-white/60">
            After registering, back up your key (nsec) once — it is the only
            portable recovery for this identity.
          </p>
        )}

        {registered && !active ? (
          <p className="mt-2 text-center text-2xs text-black/50 dark:text-white/50">
            Registered Nostr identity (re-derived on touch):{" "}
            <span className="font-mono">{passkeyStoredPubkey()}</span>
          </p>
        ) : null}

        {registered ? (
          <UserOpDemoCard disabled={!envOk || busy !== null} />
        ) : null}
      </div>
    </div>
  );
}
