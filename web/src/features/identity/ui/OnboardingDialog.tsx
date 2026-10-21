/**
 * First-run onboarding: name the durable identity and publish its profile.
 */

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { saveNewProfile } from "../lib/profile";
import { getOrCreateIdentity } from "@/shared/lib/identity";
import { createPasskeyIdentity } from "../lib/passkey-identity";
import { signInWithWallet, walletAvailable } from "../lib/siwe";
import { Fingerprint, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Overlay } from "@/shared/ui/portal";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { CREATE_ACCOUNT } from "../lib/account-copy";
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
}: {
  onDone: () => void;
  onPasskeyDone?: () => void;
}) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't create your account");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 dark:bg-black/50"
      data-testid="onboarding-dialog"
    >
      <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
        <PolicyBoxes
          ageOk={ageOk}
          agreed={agreed}
          onAgeOk={setAgeOk}
          onAgreed={setAgreed}
          state={policy}
        />
        <button
          type="button"
          onClick={() => {
            void (async () => {
              setSaving(true);
              setError(null);
              try {
                await createPasskeyIdentity(name.trim() || "Creaton user");
                accepted();
                await saveTypedName(name, about);
                (onPasskeyDone ?? onDone)();
              } catch (e) {
                setError(e instanceof Error ? e.message : "passkey failed");
                setSaving(false);
              }
            })();
          }}
          disabled={saving || !allowed}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="onboarding-passkey"
        >
          <Fingerprint className="h-4 w-4" />
          Continue with a passkey (nothing to remember)
        </button>
        {walletAvailable() ? (
          <button
            type="button"
            disabled={saving || !allowed}
            onClick={() => {
              void (async () => {
                setSaving(true);
                setError(null);
                try {
                  await signInWithWallet();
                  accepted();
                  await saveTypedName(name, about);
                  (onPasskeyDone ?? onDone)();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "wallet failed");
                  setSaving(false);
                }
              })();
            }}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-full border border-black/15 bg-white px-4 py-2 text-sm font-medium text-black hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
            data-testid="onboarding-wallet"
          >
            <Wallet className="h-4 w-4" />
            Sign in with wallet
          </button>
        ) : null}
        <div className="mb-3 flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
          or without a passkey
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
          <Sparkles className="h-5 w-5 text-black/60 dark:text-white/60" />
        </div>
        <h1 className="mt-3 text-lg font-semibold tracking-tight text-black dark:text-white">
          {CREATE_ACCOUNT}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a name and you're in. Your account lives in this browser and
          signs what you do here: messages, tasks, and what you ask your AI
          helpers to do. Save a recovery key once you're in, so you can get back
          to it.
        </p>
        <div className="mt-4 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="onboarding-name"
          />
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="About you (optional)"
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="onboarding-about"
          />
        </div>
        {error ? (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDone}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Later
          </button>
          <button
            type="button"
            disabled={saving || name.trim().length === 0 || !allowed}
            onClick={() => void submit()}
            className="rounded-full bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            data-testid="onboarding-create"
          >
            Create account
          </button>
        </div>
      </div>
    </Overlay>
  );
}
