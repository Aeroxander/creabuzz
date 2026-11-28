import { CREATE_ACCOUNT } from "@creaton/core/account/account-copy.ts";
import {
  mayCreateAccount,
  type PolicyState,
  policyRequirements,
} from "@creaton/core/account/join-policy.ts";
import {
  createPasskeyIdentity,
  hasPasskeyIdentity,
  signInPasskeyIdentity,
} from "@creaton/core/account/passkey-identity.ts";
import {
  passkeyCreateProblem,
  passkeyUnlockProblem,
} from "@creaton/core/account/passkey-problem.ts";
import { platformPasskeyAvailable } from "@creaton/core/account/platform-passkey.ts";
import { recordSignUpTerms } from "@creaton/core/account/policy-acceptance.ts";
import { parseRecoveryKey } from "@creaton/core/account/recovery-key.ts";
import { APP_NAME } from "@creaton/core/brand.ts";
import {
  getOrCreateIdentity,
  importIdentity,
  userPubkey,
} from "@creaton/core/client/identity.ts";
import { communityHostName } from "@creaton/core/client/relay-url.ts";
import { useNavigate } from "@tanstack/react-router";
import { Fingerprint } from "lucide-react";
import { useEffect, useState } from "react";
import { announceAccountChange } from "../../lib/account";
import { saveProfile } from "../../lib/profile-save";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { useToast } from "../../ui/toast";
import { Mark } from "../../app/Mark";
import { walletInBrowser } from "../money/wallet";
import { PolicyBoxes } from "./PolicyBoxes";
import { useJoinPolicy } from "./use-join-policy";

/** Only a path inside this app is followed after signing up, never another site. */
export function safeNext(next: string | undefined): string {
  return next && /^\/(?!\/)/.test(next) ? next : "/";
}

/** The account's key is saved where the person agreed: one place that records it, for every way in. */
function recordTerms(policy: PolicyState) {
  recordSignUpTerms(policy, communityHostName());
}

/**
 * Making an account (or coming back to one). The same ways in as web/'s sign-up, with the same legal boxes: a passkey
 * (the green button when this device can make one), a key kept in this browser, or the recovery key saved earlier.
 */
export function SignUpPage({ next, mode }: { next?: string; mode?: "signin" }) {
  const navigate = useNavigate();
  const { state: policy, reload } = useJoinPolicy();
  const [signingIn, setSigningIn] = useState(mode === "signin");
  const done = () => {
    announceAccountChange();
    void navigate({ to: safeNext(next) });
  };
  return (
    <main className="screen mx-auto flex min-h-dvh max-w-md flex-col gap-6">
      <div className="flex items-center gap-3 pt-2">
        <Mark size={36} />
        <span className="text-lg font-semibold tracking-tight">{APP_NAME}</span>
      </div>
      {signingIn ? (
        <SignInView
          onBack={() => setSigningIn(false)}
          onDone={done}
          onRetryPolicy={reload}
          policy={policy}
        />
      ) : (
        <CreateView
          onDone={done}
          onNotNow={() => void navigate({ to: safeNext(next) })}
          onRetryPolicy={reload}
          onSignIn={() => setSigningIn(true)}
          policy={policy}
        />
      )}
    </main>
  );
}

function CreateView({
  policy,
  onRetryPolicy,
  onDone,
  onNotNow,
  onSignIn,
}: {
  policy: PolicyState;
  onRetryPolicy: () => void;
  onDone: () => void;
  onNotNow: () => void;
  onSignIn: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [platform, setPlatform] = useState<boolean | null>(null);
  const [failedWay, setFailedWay] = useState<"passkey" | "plain" | null>(null);
  useEffect(() => {
    let live = true;
    void platformPasskeyAvailable().then((yes) => {
      if (live) setPlatform(yes);
    });
    return () => {
      live = false;
    };
  }, []);
  const allowed = mayCreateAccount(policy, { agreement: agreed, age: ageOk });
  const ready = allowed && !saving;
  // The way more likely to work gets the green: a passkey when this device can make one, unless it just failed.
  const passkeyLeads =
    failedWay !== null ? failedWay === "plain" : platform === true;
  const untickedBoxes = policy.status === "ready" && !allowed;
  // A plain account cannot send money from a phone with no wallet app, so it is offered only where it can: with a wallet in
  // this browser, or on a device that cannot make a passkey at all.
  const plainOffered = platform === false || walletInBrowser();

  const saveName = async (pubkey: string) => {
    if (name.trim().length === 0) return;
    try {
      await saveProfile(pubkey, { name });
    } catch {
      toast(
        "Your account is ready. Your name was not saved yet: add it again on You.",
      );
    }
  };

  const createPlain = async () => {
    if (!ready) return;
    setSaving(true);
    setProblem(null);
    setFailedWay(null);
    let pubkey: string;
    try {
      getOrCreateIdentity();
      recordTerms(policy);
      announceAccountChange();
      pubkey = userPubkey();
    } catch {
      setFailedWay("plain");
      setProblem(
        `This browser could not save your account. Check that it allows site data, then try again.${platform === false ? "" : " Or create it with a passkey."}`,
      );
      setSaving(false);
      return;
    }
    await saveName(pubkey);
    onDone();
  };

  const createPasskey = async () => {
    if (!ready) return;
    setSaving(true);
    setProblem(null);
    setFailedWay(null);
    try {
      const { pubkey } = await createPasskeyIdentity(
        name.trim() || `${APP_NAME} user`,
      );
      recordTerms(policy);
      announceAccountChange();
      await saveName(pubkey);
      onDone();
    } catch (error) {
      setFailedWay("passkey");
      setProblem(passkeyCreateProblem(error));
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="sign-up-title"
      className="flex flex-col gap-5"
      data-testid="onboarding-dialog"
    >
      <h1 className="headline text-3xl" id="sign-up-title">
        {CREATE_ACCOUNT}
      </h1>
      <Field
        autoComplete="nickname"
        data-testid="onboarding-name"
        label="Your name"
        onChange={(e) => setName(e.target.value)}
        value={name}
      />
      <PolicyBoxes
        ageOk={ageOk}
        agreed={agreed}
        onAgeOk={setAgeOk}
        onAgreed={setAgreed}
        onRetry={onRetryPolicy}
        state={policy}
      />
      <div className="flex flex-col gap-3" data-testid="onboarding-actions">
        {untickedBoxes ? (
          <p className="text-sm text-muted" data-testid="onboarding-tick-hint">
            {policyRequirements(policy).age
              ? "Tick both boxes to continue."
              : "Tick the box to agree to the Terms of use."}
          </p>
        ) : null}
        {problem ? (
          <p
            className="text-sm text-danger"
            data-testid="onboarding-error"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        <Button
          block
          data-testid="onboarding-passkey"
          disabled={!ready}
          onClick={() => void createPasskey()}
          variant={passkeyLeads ? "primary" : "secondary"}
        >
          <Fingerprint aria-hidden="true" size={18} />
          Create with a passkey
        </Button>
        {plainOffered ? (
          <>
            <Button
              block
              data-testid="onboarding-create"
              disabled={!ready}
              onClick={() => void createPlain()}
              variant={passkeyLeads ? "secondary" : "primary"}
            >
              Create without a passkey
            </Button>
            <p className="-mt-1 text-center text-xs text-muted">
              Without a passkey, clearing this browser's data loses the account.
            </p>
          </>
        ) : null}
      </div>
      <div className="plain flex items-center justify-between gap-2 rounded-2xl px-3 text-sm">
        <button
          className="link min-h-11 font-semibold"
          data-testid="onboarding-signin"
          onClick={onSignIn}
          type="button"
        >
          I already have an account
        </button>
        <button
          className="min-h-11 px-2 text-muted"
          onClick={onNotNow}
          type="button"
        >
          Not now
        </button>
      </div>
    </section>
  );
}

/**
 * Signing back in: with the passkey this browser already holds, or with the recovery key saved earlier (the 64
 * characters this app shows, or a key from another app). Restoring an account is a sign-up too: the same boxes.
 */
function SignInView({
  policy,
  onRetryPolicy,
  onBack,
  onDone,
}: {
  policy: PolicyState;
  onRetryPolicy: () => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const allowed = mayCreateAccount(policy, { agreement: agreed, age: ageOk });
  const passkeyHere = hasPasskeyIdentity();

  const unlock = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await signInPasskeyIdentity();
      onDone();
    } catch (error) {
      setProblem(passkeyUnlockProblem(error));
      setBusy(false);
    }
  };

  const signIn = () => {
    if (!allowed) return;
    const hex = parseRecoveryKey(key);
    if (!hex) {
      setProblem(
        "That doesn't look like a recovery key. Paste the whole key you saved.",
      );
      return;
    }
    try {
      // The key was typed in, so this account's key is already saved somewhere.
      const account = importIdentity(hex);
      localStorage.setItem("buzz.identity.backedUp", account);
      recordTerms(policy);
      onDone();
    } catch {
      setProblem(
        "This browser could not save your account. Check that it allows site data, then try again.",
      );
    }
  };

  return (
    <section aria-labelledby="sign-in-title" className="flex flex-col gap-5">
      <div>
        <h1 className="headline text-3xl" id="sign-in-title">
          Sign in
        </h1>
        <p className="mt-2 text-muted">
          {passkeyHere
            ? "Use the passkey you made here, or paste the recovery key you saved."
            : "Paste the recovery key you saved when you made your account."}
        </p>
      </div>
      {passkeyHere ? (
        <Button
          block
          data-testid="signin-passkey"
          disabled={busy}
          onClick={() => void unlock()}
        >
          <Fingerprint aria-hidden="true" size={18} />
          Sign in with your passkey
        </Button>
      ) : null}
      <form
        className="flex flex-col gap-5"
        data-testid="onboarding-signin-form"
        onSubmit={(event) => {
          event.preventDefault();
          signIn();
        }}
      >
        <Field
          autoComplete="off"
          className="num"
          data-testid="onboarding-signin-key"
          label="Recovery key"
          onChange={(e) => {
            setKey(e.target.value);
            setProblem(null);
          }}
          spellCheck={false}
          type="password"
          value={key}
        />
        <PolicyBoxes
          ageOk={ageOk}
          agreed={agreed}
          onAgeOk={setAgeOk}
          onAgreed={setAgreed}
          onRetry={onRetryPolicy}
          state={policy}
        />
        {problem ? (
          <p className="text-sm text-danger" role="alert">
            {problem}
          </p>
        ) : null}
        <Button
          block
          data-testid="onboarding-signin-submit"
          disabled={!allowed || key.trim().length === 0}
          type="submit"
          variant={passkeyHere ? "secondary" : "primary"}
        >
          Sign in
        </Button>
      </form>
      <button
        className="link min-h-11 self-start font-semibold"
        onClick={onBack}
        type="button"
      >
        Create an account
      </button>
    </section>
  );
}
