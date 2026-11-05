/**
 * First-run onboarding: name the durable identity and publish its profile.
 */

import { useEffect, useRef, useState } from "react";

import { saveNewProfile } from "../lib/profile";
import { getOrCreateIdentity, importIdentity } from "@/shared/lib/identity";
import { createPasskeyIdentity } from "../lib/passkey-identity";
import { passkeyCreateProblem } from "../lib/passkey-problem";
import { parseRecoveryKey } from "../lib/recovery-key";
import { signInWithWallet, walletAvailable } from "../lib/siwe";
import { Fingerprint, Wallet } from "lucide-react";
import { toast } from "sonner";
import {
  type FailureWords,
  errorMessage,
  failureWords,
} from "@/shared/lib/readable-error";
import { FailureNote } from "@/shared/ui/failure-note";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { CREATE_ACCOUNT } from "../lib/account-copy";
import { offerRecoveryKey } from "../lib/recovery-offer";
import { IdentityDialog } from "./IdentityDialog";
import { InviteOnlySignUpNotice } from "./InviteOnlySignUpNotice";
import {
  mayCreateAccount,
  type PolicyState,
  policyFromResponse,
  policyRequirements,
  rememberAcceptance,
} from "../lib/join-policy";

/** How long to wait for the server's terms before letting sign-up go ahead without them. */
const POLICY_TIMEOUT_MS = 5_000;

/** The server's terms of use and privacy note (`lib/join-policy.ts`). */
function useJoinPolicy(): PolicyState {
  const [state, setState] = useState<PolicyState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    let base = "";
    try {
      base = relayHttpBaseUrl();
    } catch {
      setState({ status: "unavailable" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
    fetch(`${base}/api/join-policy`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return policyFromResponse(await response.json());
      })
      .catch((): PolicyState => ({ status: "unavailable" }))
      .then((next) => {
        if (active) setState(next);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return state;
}

/** The boxes the server's policy asks for, with its terms and privacy note one click away (each opens as a page). */
function PolicyBoxes({
  state,
  agreed,
  ageOk,
  onAgreed,
  onAgeOk,
}: {
  state: PolicyState;
  agreed: boolean;
  ageOk: boolean;
  onAgreed: (value: boolean) => void;
  onAgeOk: (value: boolean) => void;
}) {
  if (state.status === "loading") {
    return (
      <p className="mb-3 text-xs text-muted-foreground" role="status">
        Loading this server's terms…
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <p
        className="mb-3 text-xs text-muted-foreground"
        data-testid="onboarding-policy-unavailable"
      >
        This server's terms of use could not be loaded right now. You will be
        asked to agree to them when it answers.
      </p>
    );
  }
  const needs = policyRequirements(state);
  if (state.status !== "ready" || (!needs.agreement && !needs.age)) return null;
  const base = relayHttpBaseUrl();
  const { policy } = state;
  const link = (path: string, label: string) => (
    <a
      className="font-medium text-foreground underline underline-offset-2"
      href={`${base}/api/join-policy/${path}`}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
  return (
    <div
      className="mb-3 space-y-2 rounded-xl border border-black/10 bg-black/[0.03] p-3 text-xs text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
      data-testid="onboarding-policy"
    >
      {needs.age ? (
        <label className="flex items-start gap-2">
          <input
            checked={ageOk}
            className="mt-0.5"
            data-testid="onboarding-policy-age"
            onChange={(e) => onAgeOk(e.target.checked)}
            type="checkbox"
          />
          <span>I am 18 years of age or older.</span>
        </label>
      ) : null}
      {needs.agreement ? (
        <label className="flex items-start gap-2">
          <input
            checked={agreed}
            className="mt-0.5"
            data-testid="onboarding-policy-agree"
            onChange={(e) => onAgreed(e.target.checked)}
            type="checkbox"
          />
          <span>
            I agree to the{" "}
            {policy.terms_markdown
              ? link("terms", "Terms of use")
              : "Terms of use"}
            {policy.privacy_markdown ? (
              <> and have read the {link("privacy", "Privacy note")}</>
            ) : null}
            . Posts and votes are public.
          </span>
        </label>
      ) : null}
    </div>
  );
}

/**
 * Save the name typed above. The passkey and wallet routes make the key without a profile, and any route can find no
 * community to write to yet (a first-time visitor has none, and making one needs an account), so the name is kept and
 * saved the first time a community answers. The account is ready either way.
 */
async function saveTypedName(name: string, about: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const saved = await saveNewProfile({
    name: trimmed,
    about: about || undefined,
  });
  if (!saved) {
    toast.message(
      "Your account is ready. Your name will be saved as soon as you join a community.",
    );
  }
}

export function OnboardingDialog({
  onDone,
  onPasskeyDone,
  startOn = "create",
  onCancel,
}: {
  onDone: () => void;
  /** Closing without an account ("Not now"); `onDone` when not given. */
  onCancel?: () => void;
  onPasskeyDone?: () => void;
  /** "signin" opens straight on the recovery-key sign-in (the nav's Sign in). */
  startOn?: "create" | "signin";
}) {
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [about, setAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FailureWords | null>(null);
  const policy = useJoinPolicy();
  const [agreed, setAgreed] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  const allowed = mayCreateAccount(policy, { agreement: agreed, age: ageOk });
  /** Called once an account is made: keep which terms were agreed to. */
  const accepted = () => {
    if (policy.status === "ready") rememberAcceptance(policy.policy.version);
  };

  const submit = async () => {
    if (name.trim().length === 0 || !allowed) return;
    setSaving(true);
    setError(null);
    try {
      getOrCreateIdentity(); // materialize the key now, visibly
      accepted();
      await saveTypedName(name, about);
      onDone();
    } catch {
      setError({
        text: "This browser could not save your account. Check that it allows site data, then try again.",
        detail: null,
      });
    } finally {
      setSaving(false);
    }
  };

  const [signingIn, setSigningIn] = useState(startOn === "signin");
  /** A passkey account was made and its recovery-key offer handed to the app's root (`lib/recovery-offer.ts`). */
  const [handedOff, setHandedOff] = useState(false);

  const createWithPasskey = () => {
    void (async () => {
      setSaving(true);
      setError(null);
      try {
        const { pubkey } = await createPasskeyIdentity(
          name.trim() || "Creaton user",
        );
        accepted();
        // A passkey signs in only in this browser: offer the key that works everywhere while it is unlocked. The offer
        // is shown by the app's root, not by this dialog, which callers unmount once someone is signed in; the caller's
        // follow-up runs when it is closed. The name is remembered on this device before saving can be cut short.
        offerRecoveryKey({ account: pubkey, onClose: onPasskeyDone ?? onDone });
        setHandedOff(true);
        await saveTypedName(name, about);
      } catch (e) {
        // The browser's own words go under Technical details for whoever helps.
        setError({ text: passkeyCreateProblem(e), detail: errorMessage(e) });
        setSaving(false);
      }
    })();
  };

  const createWithWallet = () => {
    void (async () => {
      setSaving(true);
      setError(null);
      try {
        await signInWithWallet();
        accepted();
        await saveTypedName(name, about);
        (onPasskeyDone ?? onDone)();
      } catch (e) {
        setError(
          failureWords(
            e,
            "Your wallet app did not sign you in. Open it, approve the request, then try again.",
          ),
        );
        setSaving(false);
      }
    })();
  };

  if (signingIn) {
    return (
      <SignInView
        backLabel={startOn === "signin" ? "Create an account" : "Back"}
        onBack={() => setSigningIn(false)}
        onCancel={startOn === "signin" ? (onCancel ?? onDone) : undefined}
      />
    );
  }

  if (handedOff) return null;

  const ready = name.trim().length > 0 && allowed && !saving;
  // Why the buttons below are still off once a name is typed: a box above is not ticked yet.
  const untickedBoxes =
    name.trim().length > 0 && policy.status === "ready" && !allowed;
  // A contributor-only build pays for work at a passkey account, so the passkey is the way in; without one is a
  // quiet second choice, and says what it costs.
  const passkeyFirst = !raisesOffered();
  return (
    <IdentityDialog
      cardClassName="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-background p-6 shadow-2xl"
      initialFocus={nameRef}
      labelledBy="onboarding-title"
      // Escape is "Not now", except while an account is being made.
      onEscape={saving ? undefined : (onCancel ?? onDone)}
      testId="onboarding-dialog"
    >
      <div>
        <h1
          className="text-lg font-semibold tracking-tight text-black dark:text-white"
          id="onboarding-title"
        >
          {CREATE_ACCOUNT}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick the name people will see. You can change it later.
        </p>
        <InviteOnlySignUpNotice />
        <div className="mt-4 space-y-3">
          <label
            className="block text-sm font-medium"
            htmlFor="onboarding-name"
          >
            Name
            <input
              id="onboarding-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="nickname"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus:ring-1 focus:ring-ring"
              data-testid="onboarding-name"
            />
          </label>
          <label
            className="block text-sm font-medium"
            htmlFor="onboarding-about"
          >
            About you{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
            <textarea
              id="onboarding-about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus:ring-1 focus:ring-ring"
              data-testid="onboarding-about"
            />
          </label>
        </div>
        <div className="mt-4">
          <PolicyBoxes
            ageOk={ageOk}
            agreed={agreed}
            onAgeOk={setAgeOk}
            onAgreed={setAgreed}
            state={policy}
          />
        </div>
        {untickedBoxes ? (
          <p
            className="mb-2 text-xs text-muted-foreground"
            data-testid="onboarding-tick-hint"
            id="onboarding-tick-hint"
          >
            {policyRequirements(policy).age
              ? "Tick the boxes above to continue."
              : "Tick the box to agree to the Terms of use."}
          </p>
        ) : null}
        <button
          type="button"
          aria-describedby={untickedBoxes ? "onboarding-tick-hint" : undefined}
          onClick={createWithPasskey}
          disabled={!ready}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="onboarding-passkey"
        >
          <Fingerprint className="h-4 w-4" />
          Create with a passkey
        </button>
        <p
          className="mt-1.5 text-center text-xs text-muted-foreground"
          data-testid="onboarding-passkey-note"
        >
          Sign in here with your fingerprint, face or device PIN. On another
          device you need your recovery key, which you can save next.
        </p>
        {passkeyFirst ? (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            <button
              type="button"
              aria-describedby="onboarding-create-note"
              disabled={!ready}
              onClick={() => void submit()}
              className="font-medium text-foreground underline underline-offset-2 disabled:no-underline disabled:opacity-40"
              data-testid="onboarding-create"
            >
              Create without a passkey
            </button>{" "}
            <span id="onboarding-create-note">
              You'll need a passkey to be paid for work.
            </span>
          </p>
        ) : (
          <button
            type="button"
            aria-describedby={
              untickedBoxes ? "onboarding-tick-hint" : undefined
            }
            disabled={!ready}
            onClick={() => void submit()}
            className="mt-3 w-full rounded-full border border-black/15 px-4 py-2 text-sm font-medium text-black hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:text-white dark:hover:bg-white/10"
            data-testid="onboarding-create"
          >
            Create without a passkey
          </button>
        )}
        {/* A wallet sign-up belongs with raises: the contributor-only pilot asks for no wallet. */}
        {raisesOffered() && walletAvailable() ? (
          <button
            type="button"
            disabled={!allowed || saving}
            onClick={createWithWallet}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-full px-4 py-2 text-sm text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10"
            data-testid="onboarding-wallet"
          >
            <Wallet className="h-4 w-4" />
            Use a wallet app instead
          </button>
        ) : null}
        {error ? (
          <FailureNote
            className="mt-3 text-xs text-red-600 dark:text-red-400"
            failure={error}
            testId="onboarding-error"
          />
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/10 pt-3 text-sm dark:border-white/10">
          <button
            type="button"
            onClick={() => setSigningIn(true)}
            className="font-medium text-foreground underline underline-offset-2"
            data-testid="onboarding-signin"
          >
            I already have an account
          </button>
          <button
            type="button"
            onClick={onCancel ?? onDone}
            className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
          >
            Not now
          </button>
        </div>
      </div>
    </IdentityDialog>
  );
}

/**
 * Signing back in on a browser that has no account: with the recovery key saved earlier (the 64 characters this app
 * shows, or an `nsec1…` key from another app). A passkey signs in only where it was set up, and that browser keeps the
 * account, so a new browser needs the key.
 */
function SignInView({
  onBack,
  backLabel,
  onCancel,
}: {
  onBack: () => void;
  backLabel: string;
  onCancel?: (() => void) | undefined;
}) {
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const signIn = () => {
    const hex = parseRecoveryKey(key);
    if (!hex) {
      setProblem(
        "That doesn't look like a recovery key. Paste the whole key you saved.",
      );
      return;
    }
    try {
      // The key was typed in, so this account's key is already saved somewhere (D111: the flag names the account).
      const account = importIdentity(hex);
      localStorage.setItem("buzz.identity.backedUp", account);
      window.location.reload();
    } catch {
      setProblem(
        "This browser could not save your account. Check that it allows site data, then try again.",
      );
    }
  };
  return (
    <IdentityDialog
      cardClassName="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl"
      initialFocus={keyRef}
      labelledBy="onboarding-signin-title"
      onEscape={onCancel ?? onBack}
      testId="onboarding-dialog"
    >
      <form
        data-testid="onboarding-signin-form"
        onSubmit={(event) => {
          event.preventDefault();
          signIn();
        }}
      >
        <h1
          className="text-lg font-semibold tracking-tight text-black dark:text-white"
          id="onboarding-signin-title"
        >
          Sign in
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the recovery key you saved when you made your account.
        </p>
        <label
          className="mt-4 block text-sm font-medium"
          htmlFor="onboarding-signin-key"
        >
          Recovery key
          <input
            id="onboarding-signin-key"
            ref={keyRef}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setProblem(null);
            }}
            autoComplete="off"
            spellCheck={false}
            type="password"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm font-normal outline-none focus:ring-1 focus:ring-ring"
            data-testid="onboarding-signin-key"
          />
        </label>
        {problem ? (
          <p
            className="mt-2 text-xs text-red-600 dark:text-red-400"
            role="alert"
            data-testid="onboarding-signin-problem"
          >
            {problem}
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {backLabel}
          </button>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="ml-auto rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
            >
              Not now
            </button>
          ) : null}
          <button
            type="submit"
            disabled={key.trim().length === 0}
            className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            data-testid="onboarding-signin-submit"
          >
            Sign in
          </button>
        </div>
      </form>
    </IdentityDialog>
  );
}
