import { useEffect, useReducer, useState } from "react";
import { toast } from "sonner";

import { setActionsBlocked } from "@/shared/lib/action-guard";
import { forgetIdentity, hasStoredIdentity } from "@/shared/lib/identity";
import { communityHostName, relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import { mayCreateAccount } from "../lib/join-policy";
import {
  hasPasskeyIdentity,
  removePasskeyIdentity,
} from "../lib/passkey-identity";
import {
  ACCEPTED_KEY,
  acceptedVersion,
  reacceptCheck,
  rememberAcceptance,
  subscribeAcceptance,
} from "../lib/policy-acceptance";
import { policyLinks } from "../lib/policy-links";
import type { PolicyState } from "../lib/join-policy";
import { IdentityDialog } from "./IdentityDialog";
import { PolicyBoxes } from "./PolicyBoxes";
import { BACKED_UP_KEY, hasBackedUp } from "./RecoveryKeyDialog";
import { useJoinPolicy } from "./use-join-policy";

const CHECK_TOAST = "terms-check";

/** The dialog that asks a signed-in person to agree to the terms again. "Not now" leaves the notice at the top. */
function AgainDialog({
  changed,
  state,
  onAgree,
  onNotNow,
}: {
  changed: boolean;
  state: PolicyState;
  onAgree: () => void;
  onNotNow: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  const allowed = mayCreateAccount(state, { agreement: agreed, age: ageOk });
  return (
    <IdentityDialog
      cardClassName="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-background p-6 shadow-2xl"
      labelledBy="terms-again-title"
      onEscape={onNotNow}
      testId="terms-again-dialog"
    >
      <h1
        className="text-lg font-semibold tracking-tight text-foreground"
        id="terms-again-title"
      >
        {changed ? "The terms have changed" : "Please agree to the terms"}
      </h1>
      <p className="mt-1 mb-3 text-sm text-muted-foreground">
        {changed
          ? "This server's terms of use or privacy note have changed since you last agreed. Read them, then tick the box to keep posting."
          : "This server asks you to agree to its terms of use and privacy note before you post."}
      </p>
      <PolicyBoxes
        ageOk={ageOk}
        agreed={agreed}
        onAgeOk={setAgeOk}
        onAgreed={setAgreed}
        state={state}
      />
      <p className="mb-4 text-xs text-muted-foreground">
        If you choose Not now, you can still read, save your recovery key and
        sign out. You cannot post or act until you agree.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button
          data-testid="terms-again-not-now"
          onClick={onNotNow}
          type="button"
          variant="ghost"
        >
          Not now
        </Button>
        <Button
          data-testid="terms-again-agree"
          disabled={!allowed}
          onClick={onAgree}
          type="button"
        >
          Agree and continue
        </Button>
      </div>
    </IdentityDialog>
  );
}

/**
 * Asks a signed-in person to agree again when the server's terms or privacy note change (`lib/policy-acceptance.ts`).
 * Mounted once at the app's root. While the new text is not agreed to, nothing is sent as the person
 * (`shared/lib/action-guard.ts`); they can still read, save their recovery key and sign out. A server that does not
 * answer blocks nothing: a short message says so and offers a retry.
 */
export function PolicyReacceptHost() {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const signedIn = hasStoredIdentity() || hasPasskeyIdentity();
  const host = communityHostName();
  const { state, reload } = useJoinPolicy(signedIn);
  const check = reacceptCheck({
    signedIn,
    state,
    accepted: acceptedVersion(host),
  });
  const asking = check.kind === "ask";
  const version = state.status === "ready" ? state.policy.version : "";
  // The version the person chose "Not now" for: the notice stays at the top until they agree or the text changes again.
  const [leftFor, setLeftFor] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  // Changed terms not agreed to: nothing goes out as the person until they are.
  useEffect(() => {
    setActionsBlocked(asking);
    return () => setActionsBlocked(false);
  }, [asking]);

  // A tab that agreed (or signed in) changes what this tab should show. Another tab's agreement may be to a newer text
  // than this tab loaded, so the served version is asked for again.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACCEPTED_KEY || event.key === null) {
        reload();
        refresh();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    const stop = subscribeAcceptance(refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
      stop();
    };
  }, [reload]);

  const unavailable = check.kind === "unavailable";
  useEffect(() => {
    if (!unavailable) {
      toast.dismiss(CHECK_TOAST);
      return;
    }
    toast.message(
      "We could not check whether the terms have changed. Check your connection, then try again.",
      {
        id: CHECK_TOAST,
        duration: 15_000,
        action: { label: "Try again", onClick: reload },
      },
    );
  }, [unavailable, reload]);

  const agree = () => {
    if (state.status !== "ready") return;
    const kept = rememberAcceptance(state.policy.version, host);
    if (!kept) {
      toast.message(
        "Your agreement could not be saved in this browser, so you may be asked again next time. Check that the browser allows site data.",
      );
    }
  };

  if (check.kind !== "ask") return null;
  const left = leftFor === version;
  const links = policyLinks(state, relayHttpBaseUrl());
  return (
    <>
      {left ? (
        <section
          aria-label="Terms notice"
          className="order-first flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-black/10 bg-black/[0.04] px-4 py-2 text-sm text-foreground dark:border-white/10 dark:bg-white/[0.06]"
          data-testid="terms-again-notice"
        >
          <p className="min-w-0 flex-1">
            {check.changed
              ? "You have not agreed to the changed terms, so you cannot post or act yet."
              : "You have not agreed to this server's terms, so you cannot post or act yet."}
          </p>
          {links.map((link) => (
            <a
              className="font-medium underline underline-offset-2"
              href={link.href}
              key={link.key}
              rel="noopener noreferrer"
              target="_blank"
            >
              {link.label}
            </a>
          ))}
          <Button
            data-testid="terms-again-review"
            onClick={() => setLeftFor(null)}
            size="sm"
            type="button"
          >
            Review and agree
          </Button>
          <Button
            data-testid="terms-again-sign-out"
            onClick={() => setConfirmSignOut(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Sign out
          </Button>
        </section>
      ) : (
        <AgainDialog
          changed={check.changed}
          onAgree={agree}
          onNotNow={() => setLeftFor(version)}
          state={state}
        />
      )}
      <ConfirmDialog
        confirmLabel={hasBackedUp() ? "Sign out" : "Sign out anyway"}
        description={
          hasBackedUp()
            ? "To sign back in, you need your recovery key."
            : "You have not saved your recovery key. Without it you cannot get back into this account. Choose Cancel to save it first from your profile menu."
        }
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => {
          // The same steps as the profile menu's Sign out.
          removePasskeyIdentity();
          forgetIdentity();
          localStorage.removeItem(BACKED_UP_KEY);
          window.location.assign("/");
        }}
        open={confirmSignOut}
        title="Sign out of this browser?"
      />
    </>
  );
}
