import * as React from "react";

import {
  createPasskey,
  passkeyCapability,
} from "@/features/identity/passkeyClient";
import {
  explainPasskeyError,
  type PasskeyCapability,
} from "@/features/identity/passkeyContract";
import {
  savePasskeyState,
  type PasskeyState,
} from "@/features/identity/passkeyStorage";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

type CardPhase = "loading" | "ready" | "working";

/**
 * Passkey identity card — the desktop face of the web ceremony
 * (`web/src/features/identity/lib/passkey.ts`): "Create passkey" / "Continue
 * with Touch ID" when this build can actually run a ceremony, and honest
 * explanatory copy when it cannot (today's builds cannot — the platform
 * ledger lives in `desktop/src-tauri/src/commands/passkey.rs`).
 *
 * Only NON-SECRET material is persisted (`passkeyStorage`); the Nostr secret
 * key stays in memory per docs/identity-token-architecture.md.
 */
export function PasskeyIdentityCard({ userLabel }: { userLabel?: string }) {
  const [capability, setCapability] = React.useState<PasskeyCapability | null>(
    null,
  );
  const [probeFailed, setProbeFailed] = React.useState(false);
  const [phase, setPhase] = React.useState<CardPhase>("loading");
  const [status, setStatus] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<PasskeyState | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    passkeyCapability()
      .then((result) => {
        if (cancelled) return;
        setCapability(result);
        setPhase("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setProbeFailed(true);
        setPhase("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const available = capability?.available === true;

  const onCreate = React.useCallback(() => {
    setPhase("working");
    setStatus(null);
    createPasskey({ rpName: "Buzz", userLabel: userLabel ?? "Buzz desktop" })
      .then((result) => {
        // Public material only — the secret key is never handed to storage.
        const state: PasskeyState = {
          credentialId: result.credentialId,
          salt: result.prfSalt,
          pubkey: result.identity.nostr.pubkeyHex,
          mode: "prf",
          r1UncompressedHex: result.identity.evmOwner.r1UncompressedHex,
        };
        savePasskeyState(state);
        setCreated(state);
        setStatus("Passkey created — your identity is ready on this device.");
        setPhase("ready");
      })
      .catch((error: unknown) => {
        setStatus(explainPasskeyError(error));
        setPhase("ready");
      });
  }, [userLabel]);

  return (
    <div className="py-4" data-testid="passkey-identity-card">
      <p className="text-sm font-medium">Passkey identity</p>
      <p className="mt-1 text-sm text-muted-foreground">
        One Touch ID derives your Nostr key and smart-wallet owner key — the
        same passkey identity as the web app.
      </p>

      {phase === "loading" ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          Checking passkey support…
        </p>
      ) : null}

      {probeFailed ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          Passkey support could not be checked in this build. Passkey sign-in is
          available in the web app today.
        </p>
      ) : null}

      {capability && !capability.available ? (
        <div className="mt-3" data-testid="passkey-blocker">
          <p className="text-sm text-muted-foreground" role="status">
            {capability.blocker}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            To use passkeys today, open Buzz in your browser — creating the
            passkey there makes the same identity available to every Buzz
            surface once desktop passkey support ships.
          </p>
        </div>
      ) : null}

      {available && !created ? (
        <div className="mt-3">
          <Button
            data-testid="passkey-create"
            disabled={phase === "working"}
            onClick={onCreate}
            type="button"
          >
            {phase === "working"
              ? "Waiting for Touch ID…"
              : "Continue with Touch ID"}
          </Button>
        </div>
      ) : null}

      {created ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Passkey active — Nostr key{" "}
          <span className="font-mono">{truncatePubkey(created.pubkey)}</span>
        </p>
      ) : null}

      {status ? (
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="passkey-status"
          role="status"
        >
          {status}
        </p>
      ) : null}
    </div>
  );
}
