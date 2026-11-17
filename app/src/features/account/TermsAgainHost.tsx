import { mayCreateAccount } from "@creaton/core/account/join-policy.ts";
import {
  ACCEPTED_KEY,
  acceptedVersion,
  reacceptCheck,
  rememberAcceptance,
  subscribeAcceptance,
} from "@creaton/core/account/policy-acceptance.ts";
import { setActionsBlocked } from "@creaton/core/client/action-guard.ts";
import { communityHostName } from "@creaton/core/client/relay-url.ts";
import { useEffect, useReducer, useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/sheet";
import { PolicyBoxes } from "./PolicyBoxes";
import { useJoinPolicy } from "./use-join-policy";

/**
 * Asks a signed-in person to agree again when the server's terms change (web/'s `PolicyReacceptHost`, same words).
 * Until they agree every send is stopped (`action-guard.ts`); reading, the recovery key and signing out still work.
 */
export function TermsAgainHost() {
  const { pubkey } = useAccount();
  const { state } = useJoinPolicy(pubkey !== null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = subscribeAcceptance(bump);
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACCEPTED_KEY) bump();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      off();
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const host = communityHostName();
  const check = reacceptCheck({
    signedIn: pubkey !== null,
    state,
    accepted: acceptedVersion(host),
  });
  const asking = check.kind === "ask";
  useEffect(() => {
    setActionsBlocked(asking);
  }, [asking]);
  const [notNow, setNotNow] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  if (!asking || state.status !== "ready") return null;
  const allowed = mayCreateAccount(state, { agreement: agreed, age: ageOk });
  const agree = () => {
    rememberAcceptance(state.policy.version, host);
    setActionsBlocked(false);
  };
  if (notNow)
    return (
      <div
        className="glass mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm"
        data-testid="terms-again-notice"
        role="status"
      >
        <span>You cannot post or act until you agree to the terms.</span>
        <Button onClick={() => setNotNow(false)} size="sm" variant="secondary">
          Read
        </Button>
      </div>
    );
  return (
    <Dialog
      description={
        check.changed
          ? "This server's terms of use or privacy note have changed since you last agreed. Read them, then tick the box to keep posting."
          : "This server asks you to agree to its terms of use and privacy note before you post."
      }
      onOpenChange={(open) => {
        if (!open) setNotNow(true);
      }}
      open
      testId="terms-again-dialog"
      title={
        check.changed ? "The terms have changed" : "Please agree to the terms"
      }
    >
      <PolicyBoxes
        ageOk={ageOk}
        agreed={agreed}
        onAgeOk={setAgeOk}
        onAgreed={setAgreed}
        state={state}
      />
      <p className="text-xs text-muted">
        If you choose Not now, you can still read, save your recovery key and
        sign out. You cannot post or act until you agree.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button
          data-testid="terms-again-not-now"
          onClick={() => setNotNow(true)}
          variant="ghost"
        >
          Not now
        </Button>
        <Button
          data-testid="terms-again-agree"
          disabled={!allowed}
          onClick={agree}
        >
          Agree and continue
        </Button>
      </div>
    </Dialog>
  );
}
